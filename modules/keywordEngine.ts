/**
 * 关键词抽取与标签归并（纯逻辑，不依赖 Obsidian API）
 *
 * 目标：把 PDF 里作者写的「关键词 / Keywords / Index Terms」变成干净、可复用的 Obsidian 标签。
 *
 * 处理链：
 *  1. `extractAuthorKeywordFragments`：在全文里找关键词标签（大小写、连字符、全角空格都容忍），
 *     逐段解析出作者关键词。中文期刊、Elsevier 的逐行关键词、thesis 的中英文双份关键词都能覆盖。
 *  2. `normalizeKeywordList`：清洗碎片 → 过滤元数据/正文垃圾 → 用使用者自己的词表归并到
 *     规范概念（如 machine learning / ML / 机器学习 → #机器学习）。词表由用户维护，
 *     插件不内置任何词条；本模块只负责匹配，词表内容由 `setKeywordConcepts` 注入。
 *  3. `inferKeywordsFromText`：没有关键词段的 PDF（扫描件、Nature 系无 Keywords 的论文）用
 *     标题 + 摘要命名词表，给出少量高置信度标签，而不是直接放弃。
 *
 * 所有函数都不碰 UI、vault、editor，便于单独测试。
 */

import type { KeywordConcept } from './keywordLexicon';

/** 关键词抽取选项 */
export interface KeywordExtractionOptions {
    /** 是否用语料词表归并同义关键词（false = 只清洗原文，保持原样） */
    normalize?: boolean;
    /** 没有作者关键词时，是否用标题/摘要兜底推断 */
    fallback?: boolean;
    /** 最多输出多少个标签（默认 8） */
    maxTags?: number;
}

/** 抽取结果（source 用于在 UI / 日志里说明标签从哪来） */
export interface KeywordExtractionResult {
    tags: string[];
    /** 解析出的原始作者关键词（清洗前），用于问题排查 */
    raw: string[];
    source: 'keywords' | 'inferred' | 'none';
    /** 找到的关键词段数量（中英文各算一段） */
    sections: number;
}

const DEFAULT_MAX_TAGS = 8;
const MAX_TAG_LENGTH = 40;

// ============================================================================
// 文本归一化
// ============================================================================

/**
 * 关键词匹配用的归一化：全角转半角、统一小写、统一各种破折号/连字符、
 * 去掉连字符与斜杠两侧空格、折叠空白，并去掉中英文之间的排版空格。
 *
 * 注意：这里保留 `/`（Obsidian 标签允许），也保留中文，供词表精确匹配。
 */
export function normalizeKeywordText(input: string): string {
    if (!input) return '';
    let s = input.normalize('NFKC');
    s = s.replace(/\u00ad/g, ''); // soft hyphen
    s = s.replace(/[\u00a0\u2007\u2009\u202f]/g, ' '); // 不换行/窄空格
    s = s.replace(/[‘’]/g, "'");
    s = s.replace(/[\ua3bb\ua3ac]/g, ';'); // PDF 里常见的「；」误码
    s = s.replace(/[‐‑‒–—―−]/g, '-');
    s = s.toLowerCase();
    s = s.replace(/\s*-\s*/g, '-');
    s = s.replace(/\s*\/\s*/g, '/');
    s = s.replace(/\s+/g, ' ').trim();
    // QTL 定位 → QTL定位、Cm ERF5 → CmERF5；英文词组内部的单个空格保留
    s = s.replace(/(?<=[\u3400-\u4dbf\u4e00-\u9fff])\s+(?=[A-Za-z0-9])/g, '');
    s = s.replace(/(?<=[A-Za-z0-9])\s+(?=[\u3400-\u4dbf\u4e00-\u9fff])/g, '');
    s = s.replace(/^[\s.,;:：；，、·•‧・|｜\-–—]+/g, '');
    s = s.replace(/[\s.,;:：；，、·•‧・|｜\-–—]+$/g, '');
    return s;
}

/** 英文简单复数折叠（只在纯 ASCII 且明显是复数时） */
function singularize(s: string): string {
    if (!/^[a-z0-9 \-'/]+$/.test(s)) return s;
    if (s.length > 3 && s.endsWith('s') && !s.endsWith('ss')) return s.slice(0, -1);
    return s;
}

/** 生成别名索引的查找键：空格/连字符互换、中英文间空格折叠、去空格紧凑形式 */
function aliasVariants(s: string): Set<string> {
    const out = new Set<string>();
    const add = (v: string): void => {
        if (v) out.add(v);
    };
    for (const base of [s, singularize(s)]) {
        add(base);
        add(base.replace(/\s+/g, '-'));
        add(base.replace(/[-\s]+/g, ' '));
        add(base.replace(/(?<=[\u3400-\u4dbf\u4e00-\u9fff])\s+(?=[A-Za-z0-9])/g, ''));
        add(base.replace(/(?<=[A-Za-z0-9])\s+(?=[\u3400-\u4dbf\u4e00-\u9fff])/g, ''));
        const compact = base.replace(/[-\s]+/g, '');
        if (compact.length >= 5) add(compact);
    }
    return out;
}

/** 把 `拟南芥（Arabidopsis thaliana）` 拆成 拟南芥 / Arabidopsis thaliana 两半 */
function parentheticalVariants(raw: string): string[] {
    const out = [raw];
    const stripped = raw.replace(/[（(][^（）()]*[）)]/g, ' ').replace(/\s+/g, ' ').trim();
    if (stripped && stripped !== raw) out.push(stripped);
    const inner: string[] = [];
    const re = /[（(]([^（）()]*)[）)]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw)) !== null) {
        const text = m[1].trim();
        if (text) inner.push(text);
    }
    // 只对短关键词尝试括号内内容（「拟南芥（Arabidopsis thaliana）」「single nucleotide polymorphism (SNP)」）；
    // 一整行多关键词（chrysanthemum; ... (SNP); ...）不能因为括号里有个 SNP 就把整行当成一个概念
    if (raw.length <= 60) out.push(...inner);
    return out;
}

// ============================================================================
// 词表索引（内容由使用者提供）
// ============================================================================

/**
 * 当前生效的词表。插件启动与每次保存设置时由 `setKeywordConcepts` 覆盖，
 * 之后所有匹配都只看这一份数据 —— 词表为空时自动退化为「只清洗、不归并」。
 */
let activeConcepts: KeywordConcept[] = [];

/** 注入词表（设置页保存 / 插件加载时调用），并失效所有派生索引 */
export function setKeywordConcepts(next: KeywordConcept[]): void {
    activeConcepts = Array.isArray(next) ? next.filter((c) => c && typeof c.tag === 'string') : [];
    aliasIndex = null;
    cjkAliases = null;
}

/** 当前生效的词表（设置页统计、关键词选择器展示用） */
export function getKeywordConcepts(): KeywordConcept[] {
    return activeConcepts;
}

let aliasIndex: Map<string, KeywordConcept> | null = null;

function getAliasIndex(): Map<string, KeywordConcept> {
    if (aliasIndex) return aliasIndex;
    const index = new Map<string, KeywordConcept>();
    for (const concept of activeConcepts) {
        for (const raw of [concept.tag, ...concept.aliases]) {
            const normalized = normalizeKeywordText(raw);
            if (!normalized) continue;
            for (const variant of aliasVariants(normalized)) {
                // 先到先得：同一别名写在多行时，以先出现的那一行为准
                if (!index.has(variant)) index.set(variant, concept);
            }
        }
    }
    aliasIndex = index;
    return index;
}

/** 查一个原始关键词属于哪个规范概念；查不到返回 null（保留原文） */
export function lookupKeywordConcept(raw: string): KeywordConcept | null {
    const index = getAliasIndex();
    for (const candidate of parentheticalVariants(raw)) {
        const normalized = normalizeKeywordText(candidate);
        if (!normalized) continue;
        for (const variant of aliasVariants(normalized)) {
            const hit = index.get(variant);
            if (hit) return hit;
        }
    }
    return null;
}

/** 按规范标签取概念定义（设置页/选择器展示说明用） */
export function getKeywordConcept(tag: string): KeywordConcept | null {
    const key = normalizeKeywordText(tag);
    return activeConcepts.find((c) => normalizeKeywordText(c.tag) === key) ?? null;
}

/** 纯中文别名表（按长度降序），用于把黏在一起的多个中文关键词切开 */
let cjkAliases: { text: string; concept: KeywordConcept }[] | null = null;

function getCjkAliases(): { text: string; concept: KeywordConcept }[] {
    if (cjkAliases) return cjkAliases;
    const seen = new Map<string, KeywordConcept>();
    for (const concept of activeConcepts) {
        for (const raw of [concept.tag, ...concept.aliases]) {
            const normalized = normalizeKeywordText(raw);
            if (!normalized || !/^[\u3400-\u4dbf\u4e00-\u9fff]{2,}$/.test(normalized)) continue;
            if (!seen.has(normalized)) seen.set(normalized, concept);
        }
    }
    cjkAliases = Array.from(seen.entries())
        .map(([text, concept]) => ({ text, concept }))
        .sort((a, b) => b.text.length - a.text.length);
    return cjkAliases;
}

/**
 * 中文关键词被 PDF 排版黏成一串时（如「基因编辑育种」「抗病性鉴定评价」），
 * 用词表做最长匹配切分。只对纯中文、长度 >= 6、且切出至少两段的串生效；
 * 切不动的部分原样保留，不会丢字。
 */
function segmentCjkText(text: string): string[] {
    if (text.length < 6 || !/^[\u3400-\u4dbf\u4e00-\u9fff]+$/.test(text)) return [text];
    const aliases = getCjkAliases();
    const out: string[] = [];
    let i = 0;
    let rawStart = 0;
    let matches = 0;
    while (i < text.length) {
        let hit: { text: string; concept: KeywordConcept } | null = null;
        for (const alias of aliases) {
            if (text.startsWith(alias.text, i)) {
                hit = alias;
                break;
            }
        }
        if (hit) {
            if (i > rawStart) out.push(text.slice(rawStart, i));
            out.push(hit.concept.tag);
            matches++;
            i += hit.text.length;
            rawStart = i;
        } else {
            i++;
        }
    }
    if (rawStart < text.length) out.push(text.slice(rawStart));
    return matches > 0 && out.length >= 2 ? out : [text];
}

// ============================================================================
// 单条关键词清洗
// ============================================================================

/** 合并 PDF 逐字排版产生的字母间空格：C R I S P R → CRISPR、S N P → SNP */
function mergeSpacedLetters(input: string): string {
    const tokens = input.split(/\s+/).filter(Boolean);
    const merged: string[] = [];
    for (let i = 0; i < tokens.length; i++) {
        let token = tokens[i];
        while (i + 1 < tokens.length) {
            const next = tokens[i + 1];
            const nextIsSingle = /^[A-Za-z0-9]$/.test(next);
            const tokenEndsAlnum = /[A-Za-z0-9]$/.test(token);
            const acronymPrefix = /^[A-Z]$/.test(token) && /^[A-Z0-9]/.test(next);
            if ((nextIsSingle && tokenEndsAlnum) || acronymPrefix) {
                token += next;
                i++;
                continue;
            }
            break;
        }
        merged.push(token);
    }
    return merged.join(' ');
}

/**
 * 把一条原始关键词清洗为可判断的片段：
 *  - 去掉误捕获的标签名、编号、通讯作者/缩写尾巴
 *  - 全角转半角、统一连字符
 *  - 合并逐字排版空格；去掉中文与英文/数字之间的排版空格
 *  - 中文词内的单个空格直接去掉（“种 子 耐 淹 性” → “种子耐淹性”）
 */
export function cleanKeywordFragment(raw: string): string {
    let s = raw.normalize('NFKC');
    s = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ' ');
    // PDF 抽取时偶发的私有区字符（原为图形符号/项目符号）与不换行空格
    s = s.replace(/[\uE000-\uF8FF]/g, ' ');
    s = s.replace(/[\u00a0\u2007\u2009\u202f]/g, ' ');
    s = s.replace(/\ua3bb/g, ';');
    // 误把标签本身带进来
    s = s.replace(/^(?:关\s*键\s*[词字]|主题词|key[\s\-_]*words?|index\s+terms?)\s*[：:∶]?/i, '');
    // 编号 / 项目符号 / 前导冒号
    s = s.replace(/^[\s:：∶\-–—;,，。、·•‧・|｜]+/g, '');
    s = s.replace(/^\d+[).、]\s*/, '');
    // 通讯作者、缩写表等尾巴
    s = s.replace(/\s*[*†‡]\s*correspondence\b.*$/i, '');
    s = s.replace(/\s+correspondence\b.*$/i, '');
    s = s.replace(/\s+abbreviations?\s*[:：].*$/i, '');
    // 脚注标记之后常跟作者名：Domestication †Zehong Ding
    s = s.replace(/\s*[†‡§¶].*$/, '');
    s = s.replace(/[‐‑‒–—―−]/g, '-');
    s = s.replace(/\s*-\s*/g, '-');
    s = s.replace(/\s*\/\s*/g, '/');
    s = mergeSpacedLetters(s);
    // 中英文之间的排版空格
    s = s.replace(/(?<=[\u3400-\u4dbf\u4e00-\u9fff])\s+(?=[A-Za-z0-9])/g, '');
    s = s.replace(/(?<=[A-Za-z0-9])\s+(?=[\u3400-\u4dbf\u4e00-\u9fff])/g, '');
    // 中文词内空格（逐字排版）；英文单词间空格保留
    s = s.replace(/(?<=[\u3400-\u4dbf\u4e00-\u9fff])\s+(?=[\u3400-\u4dbf\u4e00-\u9fff])/g, '');
    s = s.replace(/\s+/g, ' ').trim();
    s = s.replace(/^[\s.,;:：；，、·•‧・|｜\-–—]+/g, '');
    s = s.replace(/[\s.,;:：；，、·•‧・|｜\-–—]+$/g, '');
    return s.trim();
}

/** 明显不是关键词的碎片（元数据、正文句子、作者单位、年份等） */
const JUNK_EXACT = new Set([
    'et', 'al', 'etc', 'e.g', 'i.e', 'abstract', 'introduction', 'keywords',
    'key words', 'highlights', 'graphical abstract', 'abbreviations', 'abbreviation',
    'review', 'article', 'research article', 'original article', 'open access',
    'editorial', 'correspondence', 'contents', 'references', 'acknowledgements',
    'acknowledgments', 'supplementary', 'supplementary material', 'figure', 'table',
    'received', 'accepted', 'published', 'online', 'doi', 'and', 'of', 'for',
    'with', 'the', 'a', 'an', 'in', 'on', 'by', 'from', 'to', 'summary',
    'i', 'ii', 'iii', 'iv', 'v', 'vi',
]);

export function isJunkKeyword(raw: string): boolean {
    const s = raw.trim();
    if (!s) return true;
    const n = normalizeKeywordText(s);
    if (!n || n.length < 2) return true;
    if (/^\d+$/.test(n)) return true;
    // 年份几乎总是页眉/引用信息，而不是关键词
    if (/(?:19|20)\d{2}/.test(n)) return true;
    if (/@|https?:\/\/|www\.|doi\s*[:：]|©|all rights reserved/i.test(s)) return true;
    if (/(?:university|college|institute|department|academy|hospital|e-?mail|correspondence|corresponding author|received|accepted|published|copyright|license|citation|editorial|highlights|graphical abstract|abbreviations?)\b/i.test(n)) {
        return true;
    }
    if (/contributed equally|these authors|co-?first|present address|affiliation/i.test(n)) return true;
    if (/^(?:summary|background|conclusion|discussion|introduction|methods?|results?)$/i.test(n)) return true;
    // 作者姓名（Lili Fu、Zehong Ding）：两个及以上首字母大写的词，且不是已知概念
    if (/^[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3}$/.test(s) && !lookupKeywordConcept(s)) return true;
    // RGB 分量在关键词列表里常被误拆成 red / green / blue；单独出现没有标签价值
    if (/^(?:red|green|blue|indoor|image|gene|plant|time|estimation|algorithms?|fast|biosynthesis|development)$/i.test(n)) return true;
    if (JUNK_EXACT.has(n)) return true;
    if (!/[\p{L}\p{N}]/u.test(s)) return true;
    if (/[。！？!?]/.test(s)) return true;
    // 逗号/分号超过 2 个的碎片通常是正文或作者列表，不是单个关键词
    if (/[,，;；]/.test(s) && s.split(/[,，;；]/).length > 3) return true;
    const words = n.split(/\s+/).filter(Boolean);
    // 长句：> 10 个词且 > 60 字符；英文关键词最多也就四五个词
    if (words.length > 10 && n.length > 60) return true;
    if (n.length > 60) return true;
    // 纯括号缩写本身有价值（APX），但空括号没有
    if (/^[（(][）)]$/.test(s)) return true;
    return false;
}

/**
 * 把清洗后的片段转成 Obsidian 合法标签。
 * Obsidian 标签允许字母（含中文/希腊字母）、数字、下划线、连字符、斜杠，不允许空格与点。
 * 因此 CmRAP2.3 → CmRAP2-3，CRISPR/Cas9 保留斜杠（旧实现会删成 CRISPRCas9）。
 */
export function toObsidianTag(raw: string): string {
    let s = raw.normalize('NFKC');
    s = s.replace(/[‐‑‒–—―−]/g, '-');
    s = s.replace(/\s+/g, '-');
    s = s.replace(/[^\p{L}\p{N}_/-]+/gu, '-');
    s = s.replace(/-{2,}/g, '-').replace(/\/{2,}/g, '/');
    s = s.replace(/^[-/]+|[-/]+$/g, '');
    if (s.length > MAX_TAG_LENGTH) {
        // 在连字符边界截断，避免生成 "...coe" 这种半截标签；截不出像样的词就丢弃
        const cut = s.lastIndexOf('-', MAX_TAG_LENGTH);
        s = cut >= 12 ? s.slice(0, cut) : '';
    }
    return s;
}

// ============================================================================
// 关键词段解析
// ============================================================================

/** 关键词标签：中文 / 英文都容忍大小写、连字符、下划线、空格 */
const KEYWORD_LABEL_SOURCE = String.raw`(?:关[ \t\u3000]*键[ \t\u3000]*[词字]|主题词|[Kk][Ee][Yy][\s\-_]*[Ww][Oo][Rr][Dd][Ss]?|[Ii][Nn][Dd][Ee][Xx]\s+[Tt][Ee][Rr][Mm][Ss]?)`;
const KEYWORD_LABEL_RE = new RegExp(KEYWORD_LABEL_SOURCE, 'g');

/** 关键词之后若出现这些标题，说明列表已结束 */
const SECTION_STOP_RE = /(?:中图分类号|文献标识码|文章编号|doi\s*[:：]|收稿日期|修回日期|基金项目|作者简介|引用格式|citation\s*[:：]|https?:\/\/doi)/i;
const HEADINGS = [
    'introduction', 'materials and methods', 'material and methods', 'results', 'result',
    'discussion', 'conclusion', 'conclusions', 'references', 'acknowledgement',
    'acknowledgements', 'acknowledgment', 'acknowledgments', 'abstract', 'highlights',
    'graphical abstract', 'keywords', 'key words', 'index terms', 'summary',
    '摘要', '引言', '前言', '材料与方法', '结果', '讨论', '结论', '参考文献', '致谢',
    '关键词', '关键字', '中图分类号', '文献标识码', '文章编号', '收稿日期',
    '修回日期', '基金项目', '作者简介', '目录',
];

function isStopLine(line: string): boolean {
    const t = line.trim();
    if (!t) return false;
    if (/^\d+(?:\.\d+)*[\s.、]/.test(t)) return true;
    if (SECTION_STOP_RE.test(t)) return true;
    const lower = t.toLowerCase();
    return HEADINGS.some((h) => lower === h || lower === `${h}s`
        || lower.startsWith(`${h} `) || lower.startsWith(`${h}:`)
        || lower.startsWith(`${h}：`) || lower.startsWith(`${h}.`));
}

function hasSeparator(line: string): boolean {
    return /[；;，,、·•‧・|｜]/.test(line);
}

function isSingleEnglishKeywordLine(line: string): boolean {
    const t = line.trim().replace(/^[;；,，、:：\-–—。.]+/, '').replace(/[;；,，、:：\-–—。.]+$/, '');
    if (!t || t.length > 60) return false;
    if (!/^[A-Za-z][A-Za-z0-9 .()\-–—×/]*$/.test(t)) return false;
    if (/(?:19|20)\d{2}/.test(t)) return false;
    if (isStopLine(t)) return false;
    const compact = t.replace(/\s+/g, '').toLowerCase();
    return !JUNK_EXACT.has(compact);
}

function isSingleCjkKeywordLine(line: string): boolean {
    const t = line.trim().replace(/^[;；,，、:：\-–—。.]+/, '').replace(/[;；,，、:：\-–—。.]+$/, '');
    if (!t || t.length > 12) return false;
    if (!/^[\u3400-\u4dbf\u4e00-\u9fff（）()A-Za-z0-9·\-]+$/.test(t)) return false;
    if (/[。！？；，、]/.test(t)) return false;
    return !isStopLine(t) && !isJunkKeyword(t);
}

function looksLikeProse(line: string): boolean {
    const t = line.trim();
    if (!t) return false;
    if (/[。！？]$/.test(t)) return true;
    const words = t.split(/\s+/).filter(Boolean);
    if (words.length > 12 && t.length > 70) return true;
    if (t.length > 90) return true;
    // 参考文献行：作者 (年份). 题目. 期刊 卷, 页.
    if (/(?:19|20)\d{2}/.test(t) && /[.。]/.test(t)) return true;
    return false;
}

/** 判断关键词列表是否还会在下一行继续 */
function isKeywordContinuationLine(line: string, previous: string): boolean {
    const t = line.trim();
    if (!t) return false;
    if (isStopLine(t) || SECTION_STOP_RE.test(t)) return false;
    if (looksLikeProse(t)) return false;
    if (/(?:19|20)\d{2}/.test(t)) return false;
    // 上一行以分隔符结尾：下一行必然还是列表
    if (/[；;，,、·•‧・|｜]$/.test(previous)) return true;
    // 关键词列表换行后，下一行常以分隔符开头或小写英文开头
    if (/^[；;，,、·•‧・|｜]/.test(t)) return true;
    if (/^[a-z]/.test(t)) return true;
    // 纯中文短片段：可能是被换行截断的关键词
    const compactCjk = t.replace(/(?<=[\u3400-\u4dbf\u4e00-\u9fff])\s+(?=[\u3400-\u4dbf\u4e00-\u9fff])/g, '');
    if (/^[\u3400-\u4dbf\u4e00-\u9fff（）()A-Za-z0-9·\-]+$/.test(compactCjk) && compactCjk.length <= 12) return true;
    // 含分隔符且每段都短：是关键词列表
    if (hasSeparator(t)) {
        const parts = t.split(/[；;，,、·•‧・|｜]/).map((x) => x.trim()).filter(Boolean);
        if (parts.length >= 2 && parts.every((x) => x.length <= 16)) return true;
    }
    return false;
}

/** 标签后第一个非空行可能带前导冒号/破折号 */
function stripLabelRemainder(line: string): string {
    return line.replace(/^[\s:：∶\-–—–—]+/, '');
}

/** 一段关键词解析结果 */
interface ParsedSection {
    fragments: string[];
}

/** 解析从关键词标签之后开始的内容（最多 30 行；中文逐字排版会夹很多分隔符/噪声行） */
function parseKeywordSection(text: string, from: number): ParsedSection {
    // NFKC：全角字母/数字/连字符转半角（ＥＳＴ－ＳＳＲ → EST-SSR）；
    // 私有区字符是 PDF 字形占位符，直接当空白；
    // 不把私有区字符提前替换成空格：否则「私有区行」会变成空行，被误当成关键词列表结束。
    const rest = text.slice(from, from + 2500).normalize('NFKC');
    const lines = rest.split('\n');
    const collected: string[] = [];
    let mode: 'en' | 'cjk' | 'normal' | null = null;

    for (let i = 0; i < lines.length && i < 30; i++) {
        let line = lines[i];
        if (i === 0) line = stripLabelRemainder(line);
        line = line.trim();
        const hadVisibleContent = line.length > 0;
        // 私有区/零宽字符是 PDF 字形占位符：夹在关键词中间时当空格，单独成行时视为噪声行
        line = line
            .replace(/[\ue000-\uf8ff\u200b-\u200f\u2028\u2029]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        if (!line) {
            if (hadVisibleContent) continue;
            if (collected.length > 0) break;
            continue;
        }
        // 只有标点/分隔符的行：中文 PDF 逐字排版时常把「；」「。」单独放一行，跳过即可
        if (/^[\s:：;；,，、·•‧・|｜\-–—。.！!？?“”‘’（）()]+$/.test(line)) continue;
        if (isStopLine(line) || SECTION_STOP_RE.test(line)) break;
        // 第一行紧跟关键词标签，几乎必然是关键词本身；不要因为“长”就误判成正文
        if (collected.length > 0 && looksLikeProse(line)) break;
        // 单个汉字续行：上一个关键词被 PDF 换行截断（高分子量麦谷蛋白亚 / 基）
        if (collected.length > 0 && mode === 'cjk' && /^[\u3400-\u4dbf\u4e00-\u9fff]$/.test(line)
            && /[\u3400-\u4dbf\u4e00-\u9fff]$/.test(collected[collected.length - 1])) {
            collected[collected.length - 1] += line;
            continue;
        }

        if (collected.length === 0) {
            // 下一行若带分隔符，说明这是被换行截断的普通列表（Keywords: high-throughput /
            // phenotyping, i-trait, ...），不能按「一行一个关键词」处理
            let nextLine = '';
            for (let j = i + 1; j < lines.length; j++) {
                const candidate = lines[j].trim();
                if (candidate) {
                    nextLine = candidate;
                    break;
                }
            }
            // 下一行「以分隔符开头」是逐行关键词列表（；抗旱性），不是被换行截断的词组；
            // 下一行「中间带分隔符」才是普通列表（phenotyping, i-trait, ...）
            const nextHasSeparator = nextLine ? hasSeparator(nextLine) : false;
            const nextStartsSeparator = nextLine ? /^[;；,，、]/.test(nextLine) : false;
            const nextInternalSeparator = nextHasSeparator && !nextStartsSeparator;
            if (!hasSeparator(line) && !nextInternalSeparator && isSingleEnglishKeywordLine(line)) {
                mode = 'en';
            } else if (!hasSeparator(line) && !nextInternalSeparator && isSingleCjkKeywordLine(line)) {
                mode = 'cjk';
            } else {
                mode = 'normal';
            }
        } else if ((mode === 'cjk' || mode === 'en') && /[；;]/.test(line)) {
            // 逐行模式下，一行里仍可能用分号并排多个关键词（EST-SSR；SNP）
            const parts = line.split(/[；;]/)
                .map((part) => part.trim()
                    .replace(/^[;；,，、:：\-–—。.]+/, '')
                    .replace(/[;；,，、:：\-–—。.]+$/, ''))
                .filter(Boolean);
            const check = mode === 'cjk' ? isSingleCjkKeywordLine : isSingleEnglishKeywordLine;
            if (parts.length === 0 || !parts.every((part) => check(part))) break;
            collected.push(...parts);
            continue;
        } else if (mode === 'en') {
            if (!isSingleEnglishKeywordLine(line)) break;
        } else if (mode === 'cjk') {
            if (!isSingleCjkKeywordLine(line)) break;
        } else if (!isKeywordContinuationLine(line, collected[collected.length - 1])) {
            break;
        }

        collected.push(line);
        if (mode === 'en' && collected.length >= 10) break;
        if (mode === 'cjk' && collected.length >= 10) break;
    }

    return { fragments: splitCollectedLines(collected, mode) };
}

/** 把逐行收集到的内容拆成单个关键词 */
function splitCollectedLines(lines: string[], mode: 'en' | 'cjk' | 'normal' | null): string[] {
    if (lines.length === 0) return [];

    if (mode === 'en') {
        // 逐行一个关键词。PDF 常把两词词组拆到两行（Natural / variation、
        // Molecular / markers、indoor / phenotyping）：能拼成词表概念或下一行是小写续词时拼回。
        const assembled: string[] = [];
        for (let i = 0; i < lines.length; i++) {
            let line = lines[i];
            for (let k = 1; k <= 2 && i + k < lines.length; k++) {
                const next = lines[i + k];
                if (hasSeparator(next) || !next) break;
                const combined = `${line} ${next}`;
                const selfConcept = lookupKeywordConcept(line);
                const combinedConcept = lookupKeywordConcept(combined);
                const nextIsLower = /^[a-z]/.test(next);
                const shortPhrase = line.split(/\s+/).filter(Boolean).length <= 2;
                if ((combinedConcept && !selfConcept) || (nextIsLower && !selfConcept && shortPhrase)) {
                    line = combined;
                    i = i + k;
                    continue;
                }
                break;
            }
            assembled.push(line);
        }
        return assembled.flatMap((line) => splitFragment(line));
    }

    if (mode === 'cjk') {
        // 逐行一个中文关键词；行内若还有分隔符再拆。
        // 「高分子量麦谷蛋白亚 / 基」这种被换行截断的单字续行要拼回上一个词。
        const assembled: string[] = [];
        for (const line of lines) {
            const t = line.trim();
            if (!t) continue;
            if (/^[\u3400-\u4dbf\u4e00-\u9fff]$/.test(t)
                && assembled.length > 0
                && /[\u3400-\u4dbf\u4e00-\u9fff]$/.test(assembled[assembled.length - 1])) {
                assembled[assembled.length - 1] += t;
            } else {
                assembled.push(t);
            }
        }
        return assembled.flatMap((line) => splitFragment(line));
    }

    // 普通列表：按行拼回被 PDF 换行截断的词组，再按分隔符拆
    let joined = '';
    for (const line of lines) {
        if (!joined) {
            joined = line;
            continue;
        }
        const prevChar = joined.charAt(joined.length - 1);
        const nextChar = line.charAt(0);
        const prevIsCjk = /[\u3400-\u4dbf\u4e00-\u9fff]/.test(prevChar);
        const nextIsCjk = /[\u3400-\u4dbf\u4e00-\u9fff]/.test(nextChar);
        if (/[；;，,、·•‧・|｜\-]$/.test(joined) || /^[；;，,、·•‧・|｜]/.test(line)) {
            joined += line;
        } else if (/[A-Za-z0-9)]$/.test(joined) && /^[a-z]/.test(line)) {
            // 英文词组被换行截断（Natural / variation、multiple / nucleotide ...）
            joined += ` ${line}`;
        } else if (hasSeparator(line)) {
            // 下一行自身带分隔符：是另一个关键词，不能拼成一整串
            joined += `；${line}`;
        } else if (prevIsCjk && nextIsCjk) {
            // 中文关键词被换行截断：直接拼回
            joined += line;
        } else {
            joined += `；${line}`;
        }
    }
    return splitFragment(joined);
}

/**
 * 拆分一条（可能包含多个关键词的）片段。
 *  - 优先按中英文分号/逗号/顿号/间隔号拆
 *  - 没有标点但有 2+ 个空格：大空白是词间分隔
 *  - 没有标点、只有单个空格：用「拆开后多数片段能命中词表」判断是排版空格还是词间分隔
 */
function splitFragment(fragment: string): string[] {
    const raw = fragment.trim();
    if (!raw) return [];
    // 先统一控制字符/私有区/不换行空格，但保留“原来是否有大段空白”的信息
    const cleaned = raw
        .normalize('NFKC')
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ' ')
        .replace(/[\ue000-\uf8ff\u200b-\u200f]/g, ' ')
        .replace(/[\u00a0\u2007\u2009\u202f]/g, ' ')
        .replace(/[\ua3bb\ua3ac]/g, ';'); // PDF 里形似「；」的彝文音节字符
    const hadWideGap = /[ \t\u3000]{2,}/.test(cleaned);
    const text = cleaned.replace(/\s+/g, ' ').trim();
    if (!text) return [];
    // “yield and quality”“Mask RCNN”“red green blue (RGB) imaging”这类词组先整体查词表，
    // 避免按空格拆成单个单词后产生 and / Mask / RCNN 之类碎片
    if (lookupKeywordConcept(text)) return [text];
    // 纯中文黏连串：用词表做最长匹配切开（基因编辑育种 → 基因编辑 / 育种）。
    // 中文关键词之间的空格多是排版空格，先去掉再切；单字堆叠（种 子 耐 淹 性）不在此列。
    if (!/[；;，,、·•‧・|｜]/.test(text)) {
        const compact = text.replace(/\s+/g, '');
        if (/^[\u3400-\u4dbf\u4e00-\u9fff]{6,}$/.test(compact)) {
            const segmented = segmentCjkText(compact);
            if (segmented.length > 1) return segmented;
        }
    }
    if (/[；;，,、·•‧・|｜]/.test(text)) {
        return text.split(/[；;，,、·•‧・|｜]/).map((x) => x.trim()).filter(Boolean);
    }
    if (hadWideGap) {
        return text.split(' ').map((x) => x.trim()).filter(Boolean);
    }
    const tokens = text.split(/\s+/).filter(Boolean);
    if (tokens.length >= 2) {
        // 逐字排版“种 子 耐 淹 性”：全是单字，不能拆
        if (tokens.every((t) => t.length === 1)) return [text];
        // 含英文连接词的片段是词组（yield and quality），不能按空格拆
        const connectors = new Set(['and', 'of', 'for', 'with', 'the', 'a', 'an', 'in', 'on', 'by', 'from', 'to']);
        if (tokens.some((t) => connectors.has(t.toLowerCase()))) return [text];
        // “基因编辑 抗旱性 分子标记”：两个以上片段能命中词表，按空格拆
        const hits = tokens.filter((t) => lookupKeywordConcept(t) !== null).length;
        if (hits >= 2 && hits >= Math.ceil(tokens.length / 2)) return tokens;
        // 全是短中文（<=4 字）且没有英文：通常是多个中文关键词
        if (tokens.length >= 3 && tokens.every((t) => /^[\u3400-\u4dbf\u4e00-\u9fff]{2,6}$/.test(t))) {
            return tokens;
        }
    }
    return [text];
}

/** 关键词标签是否位于合理位置（避免把正文里的 “keywords” 单词当成标签） */
function isPlausibleLabel(text: string, start: number, end: number): boolean {
    const before = start > 0 ? text.charAt(start - 1) : '';
    const after = end < text.length ? text.charAt(end) : '';
    if (before && !/[\s.;；。：:，,、（(]/.test(before)) return false;
    if (after && !/[\s:：∶\-–—、,，]/.test(after) && !/[\u4e00-\u9fff]/.test(after)) return false;
    const lineStart = text.lastIndexOf('\n', start - 1) + 1;
    const lineEnd = text.indexOf('\n', end);
    const line = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd);
    if (line.length > 180 && start - lineStart > 40 && !/[:：]/.test(line.slice(start - lineStart, start - lineStart + 20))) {
        return false;
    }
    // 参考文献行
    if (/^\s*\[\d+\]/.test(line) || /\bet\s+al\.?\s*\(?,?\s*(?:19|20)\d{2}/.test(line)) return false;
    return true;
}

/** 一个关键词段（中文段或英文段） */
export interface AuthorKeywordSection {
    fragments: string[];
    /** 该段是否包含中文关键词 */
    hasCjk: boolean;
}

/** 在全文里找所有关键词段并解析（中英文各算一段） */
export function extractAuthorKeywordSections(text: string): AuthorKeywordSection[] {
    const cleaned = text
        .replace(/\r\n?/g, '\n')
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
    const re = new RegExp(KEYWORD_LABEL_SOURCE, 'g');
    const sections: AuthorKeywordSection[] = [];
    let total = 0;
    let match: RegExpExecArray | null;

    while ((match = re.exec(cleaned)) !== null && sections.length < 6) {
        if (!isPlausibleLabel(cleaned, match.index, match.index + match[0].length)) continue;
        const parsed = parseKeywordSection(cleaned, match.index + match[0].length);
        // 保留所有非空片段（包括 red / green 这类单独看是垃圾、但拼起来是 RGB 成像的成分），
        // 用「至少有一条不像垃圾」判断这一段是不是真的关键词段。
        const fragments: string[] = [];
        const seen = new Set<string>();
        let hasUsable = false;
        for (const fragment of parsed.fragments) {
            const cleanedFragment = cleanKeywordFragment(fragment);
            if (!cleanedFragment) continue;
            const key = normalizeKeywordText(cleanedFragment);
            if (!key || seen.has(key)) continue;
            seen.add(key);
            fragments.push(fragment);
            // 多关键词粘在一行时，按拆开后的每一条判断是否有效
            const pieces = splitFragment(fragment)
                .map((piece) => cleanKeywordFragment(piece))
                .filter(Boolean);
            if (pieces.some((piece) => !isJunkKeyword(piece))) hasUsable = true;
        }
        if (!hasUsable) continue;
        sections.push({
            fragments,
            hasCjk: fragments.some((f) => /[\u3400-\u4dbf\u4e00-\u9fff]/.test(f)),
        });
        total += fragments.length;
        if (total >= 40) break;
    }
    return sections;
}

/**
 * 选主段并合并副段：
 *  - 中文论文通常有「关键词」和「Key words」两段。中文段是作者原文，作为主段；
 *    英文段只贡献能归并到词表的概念，避免把英文翻译原样再打一遍标签。
 *  - 纯英文论文没有中文段：所有段都保留原文（不同期刊的 Keywords / Index Terms 可能互补）。
 */
export function extractAuthorKeywordFragments(
    text: string,
    opts: { mergeSecondaryConcepts?: boolean } = {}
): { fragments: string[]; sections: number } {
    const mergeSecondary = opts.mergeSecondaryConcepts !== false;
    const sections = extractAuthorKeywordSections(text);
    if (sections.length === 0) return { fragments: [], sections: 0 };

    const cjkIndex = sections.findIndex((s) => s.hasCjk && s.fragments.length >= 2);
    const fallbackCjkIndex = sections.findIndex((s) => s.hasCjk);
    let primaryIndex = cjkIndex >= 0 ? cjkIndex : fallbackCjkIndex;
    if (primaryIndex < 0) {
        primaryIndex = sections.reduce(
            (best, section, i) => (section.fragments.length > sections[best].fragments.length ? i : best),
            0
        );
    }

    const primary = sections[primaryIndex];
    const out = [...primary.fragments];
    const seen = new Set(out.map((f) => normalizeKeywordText(f)));

    for (let i = 0; i < sections.length; i++) {
        if (i === primaryIndex) continue;
        const section = sections[i];
        // 关闭同义归并时，不再从英文副段补充规范概念（否则会绕过 normalize=false）
        if (!mergeSecondary && primary.hasCjk) continue;
        for (const fragment of section.fragments) {
            const concept = lookupKeywordConcept(cleanKeywordFragment(fragment));
            // 中文主段 + 非中文副段：只补充词表概念，不把英文翻译原样加进来
            if (primary.hasCjk && !section.hasCjk && !concept) continue;
            const value = concept ? concept.tag : fragment;
            const key = normalizeKeywordText(value);
            if (!key || seen.has(key)) continue;
            seen.add(key);
            out.push(value);
        }
    }
    return { fragments: out, sections: sections.length };
}

// ============================================================================
// 规范化 / 去重
// ============================================================================

/** 把被逗号/换行拆开的词组拼回（red + green + blue (RGB) imaging、Mask + RCNN） */
function assembleAdjacentFragments(fragments: string[]): string[] {
    const out: string[] = [];
    for (let i = 0; i < fragments.length; i++) {
        let current = fragments[i];
        for (let span = 2; span <= 3 && i + span <= fragments.length; span++) {
            const combined = fragments.slice(i, i + span).join(' ');
            if (lookupKeywordConcept(combined) && !lookupKeywordConcept(current)) {
                current = combined;
                i += span - 1;
                break;
            }
        }
        out.push(current);
    }
    return out;
}

/** 把原始关键词列表变成最终标签 */
export function normalizeKeywordList(
    fragments: string[],
    opts: KeywordExtractionOptions = {}
): string[] {
    const maxTags = Math.max(1, Math.min(20, Math.floor(opts.maxTags ?? DEFAULT_MAX_TAGS)));
    const out: string[] = [];
    const seen = new Set<string>();

    const pieces = assembleAdjacentFragments(fragments.flatMap((f) => splitFragment(f)));
    for (const piece of pieces) {
        const cleaned = cleanKeywordFragment(piece);
        if (!cleaned) continue;
        // 先查词表：像「枳」「菊」这样的单字规范标签不该被「长度 < 2」的垃圾过滤丢掉
        const concept = opts.normalize === false ? null : lookupKeywordConcept(cleaned);
        if (!concept && isJunkKeyword(cleaned)) continue;
        const tag = concept ? concept.tag : toObsidianTag(cleaned);
        if (!tag || tag.length > MAX_TAG_LENGTH) continue;
        if (!concept && isJunkKeyword(tag)) continue;
        const key = tag.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(tag);
        if (out.length >= maxTags) return out;
    }
    return out;
}

// ============================================================================
// 兜底推断：没有关键词段时，用标题 + 摘要命名词表
// ============================================================================

/** 标题大致区间：取第一页开头，跳过期刊名/DOI/引用信息等行 */
function extractTitle(text: string): string {
    const head = text.slice(0, 900).split('\n');
    const kept: string[] = [];
    for (const raw of head) {
        const line = raw.trim();
        if (!line) {
            if (kept.length > 0) break;
            continue;
        }
        if (/^(?:https?:\/\/|doi\b|received|accepted|published|open access|citation|article|review|research article|original article|vol\.|volume|issn|journal)/i.test(line)) continue;
        if (/^\d+$/.test(line)) continue;
        if (/^(?:abstract|keywords?|key\s*words?|index\s+terms?|摘\s*要)/i.test(line)) break;
        kept.push(line);
        if (kept.length >= 6) break;
    }
    return kept.join(' ');
}

/** 摘要区间：从 Abstract/摘要 开始取 3000 字符；找不到则用全文开头 */
function extractAbstract(text: string): string {
    const m = /(?:^|\n)\s*(?:abstract|摘\s*要)\s*[:：]?/i.exec(text);
    if (m) {
        const start = m.index + m[0].length;
        let body = text.slice(start, start + 3200);
        const stop = /(?:\n\s*(?:keywords?|key\s*words?|index\s+terms?|introduction|引\s*言|前\s*言)\b)/i.exec(body);
        if (stop) body = body.slice(0, stop.index);
        return body;
    }
    return text.slice(0, 3200);
}

function normalizeForScan(s: string): string {
    return s
        .normalize('NFKC')
        .toLowerCase()
        .replace(/[‐‑‒–—―−]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 统计 needle 在 hay 中的出现次数；中文用 indexOf，英文用词边界 */
function countOccurrences(hay: string, needle: string): number {
    if (!needle) return 0;
    if (/[\u3400-\u4dbf\u4e00-\u9fff]/.test(needle)) {
        let count = 0;
        let idx = 0;
        while ((idx = hay.indexOf(needle, idx)) >= 0) {
            count++;
            idx += needle.length;
            if (count >= 10) break;
        }
        return count;
    }
    const re = new RegExp(`(^|[^a-z0-9])${escapeRegExp(needle)}(?=$|[^a-z0-9])`, 'g');
    let count = 0;
    while (re.exec(hay) !== null) {
        count++;
        if (count >= 10) break;
    }
    return count;
}

/**
 * 没有作者关键词时的兜底推断。
 *
 * 评分：标题命中 +4，摘要出现次数（上限 3），语料频次加成（上限 2）。
 * `generic` 概念（词表里带 * 的泛化词）只有标题命中才参与，避免摘要里的通用词占满标签。
 */
export function inferKeywordsFromText(
    text: string,
    maxTags = 5,
    exclude: Set<string> = new Set()
): string[] {
    const title = normalizeForScan(extractTitle(text));
    const abstract = normalizeForScan(extractAbstract(text));
    if (!title && !abstract) return [];

    const scored: { tag: string; score: number; corpusCount: number }[] = [];
    for (const concept of activeConcepts) {
        if (exclude.has(concept.tag.toLowerCase())) continue;
        if (scored.some((s) => s.tag === concept.tag)) continue;
        let titleHit = false;
        let abstractHits = 0;
        for (const raw of [concept.tag, ...concept.aliases]) {
            const needle = normalizeForScan(raw);
            if (!needle || needle.length < 2) continue;
            if (countOccurrences(title, needle) > 0) titleHit = true;
            abstractHits += countOccurrences(abstract, needle);
        }
        if (!titleHit && abstractHits === 0) continue;
        if (concept.generic && !titleHit) continue;
        const score = (titleHit ? 4 : 0)
            + Math.min(abstractHits, 3)
            + Math.min(Math.floor((concept.corpusCount ?? 0) / 3), 2);
        if (score < 2) continue;
        scored.push({ tag: concept.tag, score, corpusCount: concept.corpusCount ?? 0 });
    }

    scored.sort((a, b) => b.score - a.score
        || b.corpusCount - a.corpusCount
        || a.tag.localeCompare(b.tag));

    const out: string[] = [];
    const seen = new Set<string>();
    for (const item of scored) {
        const key = item.tag.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(item.tag);
        if (out.length >= Math.max(1, maxTags)) break;
    }
    return out;
}

// ============================================================================
// 主入口
// ============================================================================

/** 从 PDF 全文抽取标签（作者关键词优先，缺失时标题/摘要兜底） */
export function extractKeywordsFromText(
    text: string,
    opts: KeywordExtractionOptions = {}
): KeywordExtractionResult {
    const maxTags = Math.max(1, Math.min(20, Math.floor(opts.maxTags ?? DEFAULT_MAX_TAGS)));
    const { fragments, sections } = extractAuthorKeywordFragments(text, {
        mergeSecondaryConcepts: opts.normalize !== false,
    });
    const tags = normalizeKeywordList(fragments, { ...opts, maxTags });
    if (tags.length > 0) {
        return { tags, raw: fragments, source: 'keywords', sections };
    }
    if (opts.fallback === false) {
        return { tags: [], raw: fragments, source: 'none', sections };
    }
    const inferred = inferKeywordsFromText(text, Math.min(maxTags, 6));
    return {
        tags: inferred,
        raw: fragments,
        source: inferred.length > 0 ? 'inferred' : 'none',
        sections,
    };
}

// ============================================================================
// frontmatter tags 读写
// ============================================================================

/** 从笔记 frontmatter 读取 tags（块列表 / 行内数组 / 逗号列表都支持） */
export function parseFrontmatterTags(content: string): string[] {
    const text = content.replace(/\r\n?/g, '\n');
    const lines = text.split('\n');
    if (lines[0]?.trim() !== '---') return [];
    let end = -1;
    for (let i = 1; i < lines.length; i++) {
        if (lines[i].trim() === '---') {
            end = i;
            break;
        }
    }
    if (end < 0) return [];

    const out: string[] = [];
    const seen = new Set<string>();
    const add = (value: string): void => {
        const tag = value.trim().replace(/^#/, '').replace(/^["']|["']$/g, '').trim();
        if (!tag) return;
        const key = tag.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        out.push(tag);
    };

    for (let i = 1; i < end; i++) {
        const line = lines[i];
        const m = /^tags\s*:\s*(.*)$/i.exec(line);
        if (!m) continue;
        const inline = m[1].trim();
        if (inline) {
            const body = inline.replace(/^\[|\]$/g, '');
            for (const part of body.split(',')) add(part);
        } else {
            for (let j = i + 1; j < end; j++) {
                const item = /^\s*-\s*(.*)$/.exec(lines[j]);
                if (!item) break;
                add(item[1]);
            }
        }
        break;
    }
    return out;
}

/** 是否需要给 YAML 值加引号（标签里的常见字符都不需要，但旧标签可能有） */
function yamlSafeTag(tag: string): string {
    // YAML 1.1 会把 no / yes / on / off / null 等当成布尔或空值；数字也可能被当成数值。
    // 这些标签必须加引号，否则 Obsidian 读到的 tags 里会出现 true/false 而不是标签。
    const yamlReserved = /^(?:y|yes|n|no|true|false|on|off|null|~)$/i.test(tag)
        || /^\d+(?:\.\d+)?$/.test(tag);
    if (!yamlReserved && /^[A-Za-z0-9\u3400-\u4dbf\u4e00-\u9fff_/-]+$/.test(tag)) return tag;
    return `"${tag.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * 把新标签合并进笔记 frontmatter（保留已有标签与正文，绝不覆盖）。
 * 没有 frontmatter 时自动补一个；`tags` 是行内数组时统一改为块列表（Obsidian 官方写法）。
 *
 * @returns 新内容、实际新增的标签、合并后的全部标签
 */
export function mergeFrontmatterTags(
    content: string,
    newTags: string[]
): { content: string; added: string[]; all: string[] } {
    const eol = content.includes('\r\n') ? '\r\n' : '\n';
    const text = content.replace(/\r\n?/g, '\n');
    const normalizedNew = newTags
        .map((t) => t.trim().replace(/^#/, ''))
        .filter((t) => t.length > 0);
    if (normalizedNew.length === 0) {
        return { content, added: [], all: parseFrontmatterTags(content) };
    }

    const lines = text.split('\n');
    const hasFrontmatter = lines[0]?.trim() === '---';
    let end = -1;
    if (hasFrontmatter) {
        for (let i = 1; i < lines.length; i++) {
            if (lines[i].trim() === '---') {
                end = i;
                break;
            }
        }
    }

    // 没有合法 frontmatter：新建一个
    if (!hasFrontmatter || end < 0) {
        const existing = parseFrontmatterTags(content);
        const merged = mergeUnique(existing, normalizedNew);
        const added = merged.slice(existing.length);
        const block = ['---', 'tags:', ...merged.map((t) => `  - ${yamlSafeTag(t)}`), '---'];
        return {
            content: block.join(eol) + eol + text,
            added,
            all: merged,
        };
    }

    const existing = parseFrontmatterTags(content);
    const merged = mergeUnique(existing, normalizedNew);
    const added = merged.slice(existing.length);
    if (added.length === 0) return { content, added: [], all: existing };

    // 找 tags 行
    let tagLine = -1;
    for (let i = 1; i < end; i++) {
        if (/^tags\s*:/i.test(lines[i])) {
            tagLine = i;
            break;
        }
    }

    if (tagLine < 0) {
        // 没有 tags 字段：插到结束分隔线之前
        lines.splice(end, 0, 'tags:', ...merged.map((t) => `  - ${yamlSafeTag(t)}`));
        return { content: lines.join(eol), added, all: merged };
    }

    // 找到 tags 块的最后一行（块列表项）
    let lastItem = -1;
    for (let j = tagLine + 1; j < end; j++) {
        if (/^\s*-\s*/.test(lines[j])) {
            lastItem = j;
        } else {
            break;
        }
    }

    if (lastItem >= 0) {
        // 块列表：只在后面追加真正新增的标签
        const toAppend = added.map((t) => `  - ${yamlSafeTag(t)}`);
        lines.splice(lastItem + 1, 0, ...toAppend);
    } else {
        // tags: 后面为空 / 行内数组 / 单值：统一改写成块列表
        const replacement = ['tags:', ...merged.map((t) => `  - ${yamlSafeTag(t)}`)];
        let removeTo = tagLine + 1;
        while (removeTo < end && /^\s+/.test(lines[removeTo]) && !/^\s*-\s*/.test(lines[removeTo])) {
            removeTo++;
        }
        lines.splice(tagLine, removeTo - tagLine, ...replacement);
    }

    return { content: lines.join(eol), added, all: merged };
}

/** 合并时忽略大小写与首尾空白，保留已有写法 */
function mergeUnique(existing: string[], incoming: string[]): string[] {
    const out = [...existing];
    const seen = new Set(existing.map((t) => t.toLowerCase()));
    for (const tag of incoming) {
        const key = tag.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(tag);
    }
    return out;
}
