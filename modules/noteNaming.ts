/**
 * 阅读笔记文件名模板的共享工具
 *
 * 模板中的 `{name}` 会被替换为 PDF 文件名（不含扩展名），
 * 例如模板「{name} 阅读」+ PDF「paper.pdf」→ 笔记基础名「paper 阅读」。
 *
 * 该规则被两处共用：
 *  - PdfReaderModule：创建笔记时渲染候选文件名
 *  - ReadingNoteMarkerModule：旧笔记无 frontmatter pdf 字段时按命名反查归属 PDF
 */

/** 默认文件名模板（与历史版本「{PDF名} 阅读」行为一致） */
export const DEFAULT_NOTE_NAME_TEMPLATE = '{name} 阅读';

/**
 * 渲染模板得到笔记的基础文件名。
 * 模板中不含 {name} 时视为无效，回退默认模板（与设置面板校验一致）。
 */
export function renderNoteBaseName(pdfBasename: string, template: string): string {
    const tpl = isValidNameTemplate(template) ? template : DEFAULT_NOTE_NAME_TEMPLATE;
    return tpl.split('{name}').join(pdfBasename);
}

/** 校验模板是否有效（非空且包含 {name} 占位符） */
export function isValidNameTemplate(template: string): boolean {
    return typeof template === 'string' && template.includes('{name}');
}

/**
 * 由模板构造「从笔记基础名提取 PDF 文件名」的正则：
 *  - {name} → 贪婪捕获组 (.+)；
 *  - 模板字面量部分做正则转义；
 *  - 追加可选的「(n)」重名序号后缀捕获组（与 resolveNotePath 的去重命名一致）。
 * 返回形如 /^(.+) 阅读(?: \((\d+)\))?$/ 的正则（无 g 标志）。
 */
export function buildNoteBaseRegex(template: string): RegExp {
    const tpl = isValidNameTemplate(template) ? template : DEFAULT_NOTE_NAME_TEMPLATE;
    const escaped = tpl.split('{name}').map(escapeRegExp).join('(.+)');
    return new RegExp(`^${escaped}(?: \\((\\d+)\\))?$`);
}

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 清洗「批注链接别名」使其可以安全地放进 wikilink 的别名位置。
 *
 * 该别名会被拼进 `[[路径#锚点|别名]]`（见 PdfReaderModule 的多处写入），
 * 因此 Obsidian 语法里有特殊含义的字符必须去掉，否则会破坏生成的链接：
 *  - `|`  → 别名提前结束，后半截被当成正文
 *  - `]`  → 提前闭合 `]]`，链接目标被截断
 *  - `[`  → 可能开启嵌套链接
 *  - 换行/回车 → callout 与链接被拆行
 * 返回清洗结果；全部被清掉时调用方应回退到默认别名。
 */
export function sanitizeLinkAlias(label: string): string {
    return (label ?? '')
        .replace(/[\r\n\u2028\u2029]/g, ' ')
        .replace(/[[\]|]/g, '')
        .trim();
}

