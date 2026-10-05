import { EditorView } from '@codemirror/view';
import type { Text } from '@codemirror/state';
import type { ModuleContext, PluginModule } from '../types';

/** 批注 callout 起始行（与 PdfReaderModule 写入格式一致，前缀后允许属性） */
const CALLOUT_MARKER_RE = /^>\s*\[!pdf-annotation\]/;
/** 粘贴来源若自带引用前缀（如从其他笔记复制块引用），先剥离避免 "> >" 嵌套 */
const QUOTE_PREFIX_RE = /^>\s?/;

/**
 * 批注 callout 粘贴修正模块
 *
 * 问题：批注写入后光标停在「> 笔记：」行尾，粘贴多段文本时 Obsidian 原样插入
 * 换行，第 2 行起没有 "> " 前缀，脱离 blockquote，渲染到蓝色框外。
 *
 * 方案：注册全局 CM6 paste 事件处理器，当光标位于 [!pdf-annotation] callout 内
 * 且剪贴板为多行文本时，改写为 callout 续行格式后再插入：
 *   - 第 1 行不加前缀（衔接当前行光标处）
 *   - 第 2 行起加 "> " 前缀；空行输出 ">"（保持 callout 连续、保留分段）
 *
 * 仅拦截批注 callout，其他 blockquote/callout 的粘贴行为不变。
 * 注意与 PdfJumpModule 弃用的方案不同：这里是纯 DOM 事件监听，
 * 不涉及 StateField + effect 注入，不存在 effect 被静默忽略的问题。
 */
export class CalloutPasteModule implements PluginModule {
    constructor(private ctx: ModuleContext) {}

    load(): void {
        this.ctx.plugin.registerEditorExtension(
            EditorView.domEventHandlers({
                paste: (event, view) => this.handlePaste(event, view),
            })
        );
    }

    /** registerEditorExtension 由插件卸载时自动清理，无需显式注销 */
    unload(): void {}

    /** 命中批注 callout 内的多行粘贴时返回 true（已接管插入）；否则 false 放行默认行为 */
    private handlePaste(event: ClipboardEvent, view: EditorView): boolean {
        const text = event.clipboardData?.getData('text/plain');
        if (!text || !text.includes('\n')) return false;

        const sel = view.state.selection.main;
        const line = view.state.doc.lineAt(sel.head);
        if (!isInsideAnnotationCallout(view.state.doc, line.number)) return false;

        event.preventDefault();

        const normalized = text.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
        // 第 1 行衔接光标处不加前缀；其余行加 "> "；空行输出 ">" 维持 callout 连续
        const insert = normalized
            .split('\n')
            .map((l, i) => {
                const stripped = stripQuote(l);
                if (i === 0) return stripped;
                return stripped ? '> ' + stripped : '>';
            })
            .join('\n');

        view.dispatch({
            changes: { from: sel.from, to: sel.to, insert },
            selection: { anchor: sel.from + insert.length },
            scrollIntoView: true,
            userEvent: 'input.paste',
        });
        return true;
    }
}

/** 从光标行向上找批注 callout 起始行；空行即 blockquote 结束，未找到返回 false */
function isInsideAnnotationCallout(doc: Text, lineNo: number): boolean {
    for (let l = lineNo; l >= 1; l--) {
        const text = doc.line(l).text;
        if (!text.trim()) return false;
        if (CALLOUT_MARKER_RE.test(text)) return true;
    }
    return false;
}

function stripQuote(line: string): string {
    return line.replace(QUOTE_PREFIX_RE, '');
}
