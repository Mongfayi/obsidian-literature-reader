import { TFile, debounce } from 'obsidian';
import type { ModuleContext, PluginModule } from '../types';

/**
 * 字数统计修正模块
 *
 * Obsidian 原生状态栏字数统计（内置 word-count 插件）按笔记**源文本**计数，
 * 图片嵌入（![[x.png]]、![](data:image/png;base64,...)）、[[链接目标|别名]]、
 * 裸 URL 等语法全部被算作"词"。带大量 PDF 批注回链与截图的笔记因此虚高
 * （如《2026.9.16组会汇报》被统计为 49751 词，其中约 4.5 万词来自 base64 图片数据）。
 *
 * 本模块在不侵入 Obsidian 内部实现的前提下修正显示值：
 *  - 用 MutationObserver 跟随原生 word-count 的状态栏更新（它本身已有 200ms 防抖）；
 *  - 定位词数 segment（span.status-bar-item-segment，文本形如 "49,751 个词"），
 *    仅替换其中的数字，保留界面语言的本地化格式（字符数 segment 不动）；
 *  - 用与原生**完全一致**的词数正则重新计数（从 obsidian.asar 的 word-count
 *    Web Worker 提取，已在真实笔记上与原生值逐字对齐验证），
 *    唯一差别是计数前剥离图片/链接语法：
 *      · ![[...]] 嵌入、![alt](url) 图片 → 整体移除（渲染为图像，不产生文本）
 *      · [[目标|别名]] → 只计别名；[[目标]] → 只计显示用的 basename
 *      · [文字](url) → 只计文字；裸 URL → 移除
 *  - 有选区时统计选区（与原生行为一致），否则统计活动笔记全文。
 *
 * 降级安全：找不到词数 segment（界面语言不含"个词/词/words"单位）或无可统计
 * 文本时，保留原生显示，不做任何修改。
 */

// ===== 与 Obsidian 原生 word-count 完全一致的词数正则 =====
// 来源：obsidian.asar 内置 word-count 插件的 Web Worker 源码（Tee 字符串）。
// 结构为 `(?:数字串|字母字符)+ | 单个CJK字符`：
//  - 字母数字混合串整体算 1 词（如 "476x559"、"don't"）；
//  - 数字支持千分位逗号与小数点（"2026.9.16" 为 1 词）；
//  - CJK 表意文字（含假名、谚文音节外的藏文等）每字 1 词。
// LATIN_CLASS / CJK_CLASS 为从 asar 提取的原样字符集（\u 转义形式，勿手改）。
const LATIN_CLASS = 'A-Za-z\u00AA\u00B5\u00BA\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02C1\u02C6-\u02D1\u02E0-\u02E4\u02EC\u02EE\u0370-\u0374\u0376\u0377\u037A-\u037D\u037F\u0386\u0388-\u038A\u038C\u038E-\u03A1\u03A3-\u03F5\u03F7-\u0481\u048A-\u052F\u0531-\u0556\u0559\u0561-\u0587\u05D0-\u05EA\u05F0-\u05F2\u0620-\u064A\u066E\u066F\u0671-\u06D3\u06D5\u06E5\u06E6\u06EE\u06EF\u06FA-\u06FC\u06FF\u0710\u0712-\u072F\u074D-\u07A5\u07B1\u07CA-\u07EA\u07F4\u07F5\u07FA\u0800-\u0815\u081A\u0824\u0828\u0840-\u0858\u08A0-\u08B4\u0904-\u0939\u093D\u0950\u0958-\u0961\u0971-\u0980\u0985-\u098C\u098F\u0990\u0993-\u09A8\u09AA-\u09B0\u09B2\u09B6-\u09B9\u09BD\u09CE\u09DC\u09DD\u09DF-\u09E1\u09F0\u09F1\u0A05-\u0A0A\u0A0F\u0A10\u0A13-\u0A28\u0A2A-\u0A30\u0A32\u0A33\u0A35\u0A36\u0A38\u0A39\u0A59-\u0A5C\u0A5E\u0A72-\u0A74\u0A85-\u0A8D\u0A8F-\u0A91\u0A93-\u0AA8\u0AAA-\u0AB0\u0AB2\u0AB3\u0AB5-\u0AB9\u0ABD\u0AD0\u0AE0\u0AE1\u0AF9\u0B05-\u0B0C\u0B0F\u0B10\u0B13-\u0B28\u0B2A-\u0B30\u0B32\u0B33\u0B35-\u0B39\u0B3D\u0B5C\u0B5D\u0B5F-\u0B61\u0B71\u0B83\u0B85-\u0B8A\u0B8E-\u0B90\u0B92-\u0B95\u0B99\u0B9A\u0B9C\u0B9E\u0B9F\u0BA3\u0BA4\u0BA8-\u0BAA\u0BAE-\u0BB9\u0BD0\u0C05-\u0C0C\u0C0E-\u0C10\u0C12-\u0C28\u0C2A-\u0C39\u0C3D\u0C58-\u0C5A\u0C60\u0C61\u0C85-\u0C8C\u0C8E-\u0C90\u0C92-\u0CA8\u0CAA-\u0CB3\u0CB5-\u0CB9\u0CBD\u0CDE\u0CE0\u0CE1\u0CF1\u0CF2\u0D05-\u0D0C\u0D0E-\u0D10\u0D12-\u0D3A\u0D3D\u0D4E\u0D5F-\u0D61\u0D7A-\u0D7F\u0D85-\u0D96\u0D9A-\u0DB1\u0DB3-\u0DBB\u0DBD\u0DC0-\u0DC6\u0E01-\u0E30\u0E32\u0E33\u0E40-\u0E46\u0E81\u0E82\u0E84\u0E87\u0E88\u0E8A\u0E8D\u0E94-\u0E97\u0E99-\u0E9F\u0EA1-\u0EA3\u0EA5\u0EA7\u0EAA\u0EAB\u0EAD-\u0EB0\u0EB2\u0EB3\u0EBD\u0EC0-\u0EC4\u0EC6\u0EDC-\u0EDF\u1000-\u102A\u103F\u1050-\u1055\u105A-\u105D\u1061\u1065\u1066\u106E-\u1070\u1075-\u1081\u108E\u10A0-\u10C5\u10C7\u10CD\u10D0-\u10FA\u10FC-\u1248\u124A-\u124D\u1250-\u1256\u1258\u125A-\u125D\u1260-\u1288\u128A-\u128D\u1290-\u12B0\u12B2-\u12B5\u12B8-\u12BE\u12C0\u12C2-\u12C5\u12C8-\u12D6\u12D8-\u1310\u1312-\u1315\u1318-\u135A\u1380-\u138F\u13A0-\u13F5\u13F8-\u13FD\u1401-\u166C\u166F-\u167F\u1681-\u169A\u16A0-\u16EA\u16F1-\u16F8\u1700-\u170C\u170E-\u1711\u1720-\u1731\u1740-\u1751\u1760-\u176C\u176E-\u1770\u1780-\u17B3\u17D7\u17DC\u1820-\u1877\u1880-\u18A8\u18AA\u18B0-\u18F5\u1900-\u191E\u1950-\u196D\u1970-\u1974\u1980-\u19AB\u19B0-\u19C9\u1A00-\u1A16\u1A20-\u1A54\u1AA7\u1B05-\u1B33\u1B45-\u1B4B\u1B83-\u1BA0\u1BAE\u1BAF\u1BBA-\u1BE5\u1C00-\u1C23\u1C4D-\u1C4F\u1C5A-\u1C7D\u1CE9-\u1CEC\u1CEE-\u1CF1\u1CF5\u1CF6\u1D00-\u1DBF\u1E00-\u1F15\u1F18-\u1F1D\u1F20-\u1F45\u1F48-\u1F4D\u1F50-\u1F57\u1F59\u1F5B\u1F5D\u1F5F-\u1F7D\u1F80-\u1FB4\u1FB6-\u1FBC\u1FBE\u1FC2-\u1FC4\u1FC6-\u1FCC\u1FD0-\u1FD3\u1FD6-\u1FDB\u1FE0-\u1FEC\u1FF2-\u1FF4\u1FF6-\u1FFC\u2071\u207F\u2090-\u209C\u2102\u2107\u210A-\u2113\u2115\u2119-\u211D\u2124\u2126\u2128\u212A-\u212D\u212F-\u2139\u213C-\u213F\u2145-\u2149\u214E\u2183\u2184\u2C00-\u2C2E\u2C30-\u2C5E\u2C60-\u2CE4\u2CEB-\u2CEE\u2CF2\u2CF3\u2D00-\u2D25\u2D27\u2D2D\u2D30-\u2D67\u2D6F\u2D80-\u2D96\u2DA0-\u2DA6\u2DA8-\u2DAE\u2DB0-\u2DB6\u2DB8-\u2DBE\u2DC0-\u2DC6\u2DC8-\u2DCE\u2DD0-\u2DD6\u2DD8-\u2DDE\u2E2F\u3005\u3006\u3031-\u3035\u303B\u303C\u3105-\u312D\u3131-\u318E\u31A0-\u31BA\u31F0-\u31FF\u3400-\u4DB5\uA000-\uA48C\uA4D0-\uA4FD\uA500-\uA60C\uA610-\uA61F\uA62A\uA62B\uA640-\uA66E\uA67F-\uA69D\uA6A0-\uA6E5\uA717-\uA71F\uA722-\uA788\uA78B-\uA7AD\uA7B0-\uA7B7\uA7F7-\uA801\uA803-\uA805\uA807-\uA80A\uA80C-\uA822\uA840-\uA873\uA882-\uA8B3\uA8F2-\uA8F7\uA8FB\uA8FD\uA90A-\uA925\uA930-\uA946\uA984-\uA9B2\uA9CF\uA9E0-\uA9E4\uA9E6-\uA9EF\uA9FA-\uA9FE\uAA00-\uAA28\uAA40-\uAA42\uAA44-\uAA4B\uAA60-\uAA76\uAA7A\uAA7E-\uAAAF\uAAB1\uAAB5\uAAB6\uAAB9-\uAABD\uAAC0\uAAC2\uAADB-\uAADD\uAAE0-\uAAEA\uAAF2-\uAAF4\uAB01-\uAB06\uAB09-\uAB0E\uAB11-\uAB16\uAB20-\uAB26\uAB28-\uAB2E\uAB30-\uAB5A\uAB5C-\uAB65\uAB70-\uABE2\uD7CB-\uD7FB\uF900-\uFA6D\uFA70-\uFAD9\uFB00-\uFB06\uFB13-\uFB17\uFB1D\uFB1F-\uFB28\uFB2A-\uFB36\uFB38-\uFB3C\uFB3E\uFB40\uFB41\uFB43\uFB44\uFB46-\uFBB1\uFBD3-\uFD3D\uFD50-\uFD8F\uFD92-\uFDC7\uFDF0-\uFDFB\uFE70-\uFE74\uFE76-\uFEFC\uFF21-\uFF3A\uFF41-\uFF5A\uFF66-\uFFBE\uFFC2-\uFFC7\uFFCA-\uFFCF\uFFD2-\uFFD7\uFFDA-\uFFDC';
const CJK_CLASS = '\u0F00\u0F40-\u0F47\u0F49-\u0F6C\u0F88-\u0F8C\u3041-\u3096\u309D-\u309F\u30A1-\u30FA\u30FC-\u30FF\u4E00-\u9FD5\uAC00-\uD7A3\uA960-\uA97C\uD7B0-\uD7C6';
/** Worker 中追加到连续类的补充范围：泰米尔文与谚文（U+0B80-0BFF、AC00-D7A3、A960-A97C、D7B0-D7C6） */
const EXTRA_CLASS = '\\u0B80-\\u0BFF\\uAC00-\\uD7A3\\uA960-\\uA97C\\uD7B0-\\uD7C6';
const WORD_RE = new RegExp(
    // 字符类中的两个引号：U+0027 直引号与 U+2019 弯引号（don't / don’t 均为 1 词）
    "(?:[0-9]+(?:(?:,|\\.)[0-9]+)*|[\\-'\\u2019" + LATIN_CLASS + EXTRA_CLASS + "])+|[" + CJK_CLASS + "]",
    'g'
);

/** 与原生一致的词数计数（match 全局正则取匹配数） */
function countWords(text: string): number {
    const m = text.match(WORD_RE);
    return m ? m.length : 0;
}

/** 剥离 frontmatter（复刻原生 Dee/Xx：仅当首行为 --- 且有闭合行时剥离） */
function stripFrontmatter(text: string): string {
    if (!text.startsWith('---')) return text;
    const m = /^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)\r?\n?/.exec(text);
    return m ? text.slice(m[0].length) : text;
}

/**
 * 剥离图片与链接语法，只保留渲染后可见的文本。
 * 图片/PDF 页嵌入不产生文本故整体移除；链接保留用户可见的显示部分。
 */
function stripImagesAndLinks(text: string): string {
    return (
        text
            // 嵌入：![[图片.png]]、![[essay/x.pdf#page=1&rect=...]]
            .replace(/!\[\[[^\]]*\]\]/g, '')
            // Markdown 图片：![alt](url)，含 ![](data:image/...;base64,...)
            .replace(/!\[[^\]]*\]\([^)\n]*\)/g, '')
            // 损坏的图片残骸：![<超长base64>) （复制粘贴时丢失 "](" 与 data: 前缀的产物）
            .replace(/!\[[^()[\]\n]{100,}\)/g, '')
            // Wikilink：[[目标|别名]] → 别名；[[目标]] → 渲染时显示的 basename
            .replace(/\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g, (_m, target: string, display?: string) => {
                if (display !== undefined && display !== '') return display;
                const beforeHash = target.split('#');
                // [[#小节]] 类当前文件内链显示小节名
                const visible = (beforeHash[0] || beforeHash[1] || '').trim();
                const base = visible.split('/').pop() || '';
                // 仅剥离结尾的纯字母扩展名（.pdf/.md 等），避免误伤 "2026.9.16组会汇报"
                return base.replace(/\.[A-Za-z]{1,8}$/, '');
            })
            // Markdown 链接：[文字](url) → 文字
            .replace(/\[([^\]]*)\]\([^)\n]*\)/g, '$1')
            // 裸 URL（含 <http://...> 自动链接形式）
            .replace(/<https?:\/\/[^>\s]+>/g, '')
            .replace(/https?:\/\/[^\s<>)]+/g, '')
    );
}

/** 状态栏词数 segment 的文本格式（保留原生本地化单位，仅替换数字） */
const WORD_SEGMENT_RE = /^\s*[\d,，.\s]*\d[\d,，.\s]*(?:个\s*词|词|words?)\s*$/i;
/** 从 segment 文本中分离数字前缀与本地化后缀，如 "49,751 个词" → ["49,751", " 个词"] */
const NUMBER_PREFIX_RE = /^(\s*)([\d,，]+)([\s\S]*)$/;

/**
 * 「几乎没有可剥离内容」的快速判据。
 *
 * 计算修正词数需要 stripFrontmatter + stripImagesAndLinks 的多次全文替换，
 * 再把结果交给 WORD_RE 全量匹配。原生 word-count 在 Web Worker 里算，
 * 这几步却跑在 UI 线程上，因此每次编辑停顿都要把整篇笔记过好几遍。
 * 但绝大多数笔记里并没有图片嵌入 / 链接语法：先用一次廉价的 indexOf
 * 判断「要不要剥离」，不需要就只做最后那一次无法避免的词数匹配。
 * 判据必须覆盖 stripImagesAndLinks 匹配到的所有形式（其正则都以这些needle开头）。
 */
const MAY_NEED_STRIP = ['![[', '![', '[[', '](', 'http'];
function mayNeedStripping(text: string): boolean {
    for (const needle of MAY_NEED_STRIP) {
        if (text.indexOf(needle) >= 0) return true;
    }
    return false;
}

export class WordCountFixModule implements PluginModule {
    private ctx: ModuleContext;

    /** 状态栏容器 */
    private statusBarEl: HTMLElement | null = null;
    private observer: MutationObserver | null = null;

    /** 上次写入的文本（避免 observer 自触发死循环） */
    private lastApplied = '';
    /** 被修改元素的原生文本，unload/关闭开关时恢复 */
    private originalText = '';

    /** 统计缓存：相同输入文本直接复用结果（光标移动等场景零重算） */
    private cacheInput: string | null = null;
    private cacheCount = 0;

    /** 阅读模式异步读取后的写入令牌，防止竞态覆盖新状态 */
    private asyncToken = 0;

    constructor(ctx: ModuleContext) {
        this.ctx = ctx;
    }

    load(): void {
        this.ctx.plugin.app.workspace.onLayoutReady(() => {
            this.statusBarEl = document.querySelector('.status-bar');
            if (!this.statusBarEl) return;
            this.observer = new MutationObserver(() => this.scheduleFix());
            // 原生 word-count 在 file-open / selection-change / quick-preview 时
            // 更新 segment 文本（自带 200ms 防抖），我们跟随其 DOM 变化即可
            this.observer.observe(this.statusBarEl, {
                childList: true,
                subtree: true,
                characterData: true,
            });
            this.scheduleFix();
        });
        this.ctx.plugin.register(() => this.cleanup());
    }

    unload(): void {
        this.cleanup();
    }

    /** 设置页开关切换：开启→立即重算；关闭→恢复原生显示 */
    setEnabled(value: boolean): void {
        if (value) {
            this.lastApplied = '';
            this.scheduleFix();
        } else {
            this.restoreOriginal();
        }
    }

    private cleanup(): void {
        this.observer?.disconnect();
        this.observer = null;
        this.restoreOriginal();
        this.scheduleFix.cancel();
        this.cacheInput = null;
    }

    /** 恢复被我们替换过的词数 segment 原生文本 */
    private restoreOriginal(): void {
        const el = this.findWordSegment();
        if (el && this.originalText && el.textContent !== this.originalText) {
            el.textContent = this.originalText;
        }
        this.lastApplied = '';
        this.originalText = '';
    }

    /** 在原生 200ms 防抖之上再缓冲一层，合并连续编辑触发的多次更新 */
    private scheduleFix = debounce(() => this.applyFix(), 250, true);

    private applyFix(): void {
        const enabled = this.ctx.getSettings().wordCountFixEnabled !== false;
        const el = this.findWordSegment();
        if (!el) return;

        if (!enabled) {
            if (this.originalText && el.textContent !== this.originalText) {
                el.textContent = this.originalText;
                this.lastApplied = '';
                this.originalText = '';
            }
            return;
        }

        const raw = el.textContent ?? '';
        if (raw === this.lastApplied) return; // 已是我们的写入值（防 observer 循环）

        const m = NUMBER_PREFIX_RE.exec(raw);
        if (!m) return; // 数字不在开头（不支持的语言布局），保留原生
        const [, prefix, numStr, suffix] = m;

        const text = this.getSyncText();
        if (text !== null) {
            this.writeFixed(el, raw, prefix, numStr, suffix, this.countFixedWords(text));
            return;
        }

        // 编辑器不可用（阅读模式等）：异步读活动笔记全文，读回后校验再写入
        const file = this.ctx.plugin.app.workspace.getActiveFile();
        if (!(file instanceof TFile) || file.extension !== 'md') return;
        const token = ++this.asyncToken;
        void this.ctx.plugin.app.vault.cachedRead(file).then(
            (content) => {
                if (token !== this.asyncToken) return; // 期间已有新的统计请求
                const cur = this.findWordSegment();
                if (!cur || (cur.textContent ?? '') !== raw) return; // 原生已更新到别处
                this.writeFixed(cur, raw, prefix, numStr, suffix, this.countFixedWords(content));
            },
            () => {
                // 读取失败：保留原生显示
            }
        );
    }

    /** 把修正后的词数写回 segment，保持原生数字格式（千分位）与本地化后缀 */
    private writeFixed(
        el: HTMLElement,
        raw: string,
        prefix: string,
        numStr: string,
        suffix: string,
        count: number
    ): void {
        const formatted =
            numStr.includes(',') || numStr.includes('，')
                ? count.toLocaleString()
                : String(count);
        this.originalText = raw;
        this.lastApplied = prefix + formatted + suffix;
        el.textContent = this.lastApplied;
    }

    /**
     * 同步获取当前应统计的文本：
     * 有选区→选区文本（与原生 onSelection 一致）；否则→编辑器缓冲全文。
     * 无编辑器（阅读模式/非笔记视图）返回 null 交由异步路径处理。
     */
    private getSyncText(): string | null {
        const editor = this.ctx.plugin.app.workspace.activeEditor?.editor;
        if (!editor) return null;
        const sel = editor.getSelection();
        return sel ? sel : editor.getValue();
    }

    /**
     * 统计修正词数（带输入缓存）。
     *
     * 没有可剥离内容时直接对原文计数，跳过 stripFrontmatter / stripImagesAndLinks
     * 的多次全文替换 —— 这是本模块在 UI 线程上的主要开销。
     */
    private countFixedWords(text: string): number {
        if (text === this.cacheInput) return this.cacheCount;
        const count = mayNeedStripping(text)
            ? countWords(stripImagesAndLinks(stripFrontmatter(text)))
            : countWords(stripFrontmatter(text));
        this.cacheInput = text;
        this.cacheCount = count;
        return count;
    }

    /**
     * 定位原生 word-count 的词数 segment。
     * 它是 span.status-bar-item-segment，文本为数字+本地化词单位（"个词"/"words"）；
     * 字符数 segment（"个字符"/"characters"）与反向链接等其它状态项均不匹配。
     */
    private findWordSegment(): HTMLElement | null {
        if (!this.statusBarEl) this.statusBarEl = document.querySelector('.status-bar');
        const bar = this.statusBarEl;
        if (!bar) return null;
        for (const el of Array.from(bar.querySelectorAll<HTMLElement>('.status-bar-item-segment'))) {
            const text = el.textContent ?? '';
            if (text && WORD_SEGMENT_RE.test(text)) return el;
        }
        return null;
    }
}
