import { Setting, ToggleComponent } from 'obsidian';
import type { TFile } from 'obsidian';
import type { ModuleContext, PluginModule } from '../types';

/**
 * 搜索增强模块
 *
 * 汇集 Obsidian 核心搜索的行为增强。每个子功能占一个独立设置键，
 * 后续新的搜索相关功能（如过滤、排序增强等）直接在模块内扩展代码段即可。
 *
 * 当前子功能：
 *  1. 忽略链接（searchIgnoreLinks）——核心搜索的匹配结果中，剔除落在
 *     [[链接目标|别名]] 目标部分与 [文字](url) url 部分内的匹配区间，
 *     阅读笔记里的 PDF 批注回链不再命中搜索；别名、文件名与正文照常可搜。
 *
 * 实现说明：核心搜索对每个文件在主线程调用内部查询类原型的 match(file, content)，
 * 返回形如 { content: [[start,end],...], filename: ... } 的匹配结果；结果组件随后
 * 在「原文」上按这些区间渲染命中行与 <mark> 高亮。因此这里不改写任何文本，
 * 只在 match 返回后过滤区间——原文、匹配、高亮三者永远一致，不会错位。
 *
 * 补丁时机：包装搜索视图实例的 searchQuery 属性为访问器，查询对象在 startSearch
 * 里一创建（this.searchQuery = a）即捕获其原型并完成包装，保证首次搜索的结果
 * 就已经过滤，无需二次搜索（二次搜索会与结果 DOM 缓存互相干扰产生错位高亮）。
 *
 * ⚠️ 依赖 Obsidian 内部结构（searchParamsContainerEl / searchQuery 赋值语句），
 * 版本更新可能变动；所有步骤做特性检测，失效时仅本模块功能停用并输出警告，
 * 不影响插件其余功能。
 *
 * 面板定位做了三级兜底（内部属性 → .search-params 类名 → 已注入开关的父节点），
 * 并对「视图尚未构造完」的情况登记重试、对 DOM 重绘挂 MutationObserver 续接。
 * 搜索面板打开后可用 `app.plugins.plugins['pdf-reader'].searchDiagnostics()`
 * 查看开关是否正确挂载。
 */

/** 核心搜索视图上用到的内部属性/方法（最小约定，仅做特性检测用） */
interface SearchViewLike {
    /** 搜索选项面板容器（原生三个开关所在） */
    searchParamsContainerEl?: HTMLElement;
    /** 当前查询对象；由 startSearch 以普通属性赋值写入 */
    searchQuery?: unknown;
    startSearch?: (...args: unknown[]) => void;
    searchComponent?: { getValue?: () => string };
    /** 视图根容器（面板定位的兜底入口） */
    containerEl?: HTMLElement;
}

/** 安装 searchQuery 访问器时使用的存储字段 */
interface QueryHolderView extends SearchViewLike {
    __lrSearchQuery?: unknown;
}

/** 查询类原型上的匹配方法签名 */
type MatchFn = (this: unknown, file: TFile, content: string) => unknown;

/** 字符区间 [start, end)（UTF-16 码元偏移，与核心搜索的区间约定一致） */
type Range = [number, number];

/** 注入开关的标记类，卸载时按类名统一清理 DOM（覆盖多窗口） */
const TOGGLE_CLASS = 'literature-reader-search-ignore-links';

/** 原生搜索选项面板的类名（与 searchParamsContainerEl 指向同一元素） */
const PARAMS_SELECTOR = '.search-params';
/** 未就绪的视图最多搭车重试多少次（之后交回 layout-change 事件驱动） */
const MAX_PENDING_ATTEMPTS = 20;

export class SearchEnhancementModule implements PluginModule {
    private ctx: ModuleContext;
    /** 已处理的视图 -> 是否安装了 searchQuery 访问器（卸载时逐个还原） */
    private attachedViews = new Map<object, boolean>();
    /** 已注入的开关组件，用于搜索面板多视图/设置页之间同步显示 */
    private toggles = new Set<ToggleComponent>();
    /** 被包装的查询类原型及其原 match */
    private wrappedQueryProto: object | null = null;
    private origMatch: MatchFn | null = null;
    /** 面板尚未就绪的视图 -> 已搭车重试次数（避免事件时序导致的永久漏挂） */
    private pendingViews = new Map<object, number>();
    /** 已就未绪告警过的视图（每视图最多一条，避免事件频繁触发时刷屏） */
    private warnedViews = new WeakSet<object>();

    constructor(ctx: ModuleContext) {
        this.ctx = ctx;
    }

    load(): void {
        const workspace = this.ctx.plugin.app.workspace;
        // 搜索面板是懒创建的：首次打开后 layout-change 才能枚举到 search 叶子
        this.ctx.plugin.registerEvent(workspace.on('layout-change', () => this.attachAll()));
        this.ctx.plugin.registerEvent(workspace.on('active-leaf-change', () => this.attachAll()));
        this.attachAll();
    }

    unload(): void {
        if (this.wrappedQueryProto && this.origMatch) {
            (this.wrappedQueryProto as { match?: unknown }).match = this.origMatch;
            this.wrappedQueryProto = null;
            this.origMatch = null;
        }
        for (const view of Array.from(this.attachedViews.keys())) {
            this.uninstallQueryAccessor(view as QueryHolderView);
        }
        this.attachedViews.clear();
        this.pendingViews.clear();
        document.querySelectorAll('.' + TOGGLE_CLASS).forEach((el) => el.remove());
        this.toggles.clear();
    }

    /**
     * 诊断快照（控制台可调用，用于确认开关是否真的挂上了）：
     * 打开搜索面板后执行 `app.plugins.plugins['pdf-reader'].searchDiagnostics()`
     */
    searchDiagnostics(): Record<string, unknown> {
        return {
            已挂载视图数: this.attachedViews.size,
            待就绪视图数: this.pendingViews.size,
            查询类已包装: this.wrappedQueryProto !== null,
            开关组件数: this.toggles.size,
            搜索叶子数: this.ctx.plugin.app.workspace.getLeavesOfType('search').length,
            页面内面板数: document.querySelectorAll(PARAMS_SELECTOR).length,
            页面内开关数: document.querySelectorAll('.' + TOGGLE_CLASS).length,
            忽略链接开关: this.ignoreLinksEnabled(),
        };
    }

    /** 子功能开关当前状态 */
    private ignoreLinksEnabled(): boolean {
        return this.ctx.getSettings().searchIgnoreLinks === true;
    }

    /** 枚举所有搜索视图（含弹窗窗口）并注入开关、确保补丁就位 */
    private attachAll(): void {
        const leaves = this.ctx.plugin.app.workspace.getLeavesOfType('search');
        for (const leaf of leaves) {
            this.attachView(leaf.view as unknown as SearchViewLike);
        }
        this.retryPendingViews();
    }

    /**
     * 为「上次没找到面板」的视图补挂。
     *
     * 搜索视图在叶子出现时可能尚未构造完（layout-change 早于视图 DOM 就绪），
     * 那时取不到面板；只等下一个 layout-change 有可能一直等不到（用户不再开关面板），
     * 所以让后续的 attachAll（本身由事件驱动）顺带重试，次数用尽后停止。
     */
    private retryPendingViews(): void {
        if (this.pendingViews.size === 0) return;
        for (const [view, attempts] of Array.from(this.pendingViews.entries())) {
            if (this.attachedViews.has(view)) {
                this.pendingViews.delete(view);
                continue;
            }
            if (attempts >= MAX_PENDING_ATTEMPTS) {
                this.pendingViews.delete(view);
                console.warn(
                    '[LiteratureReader] 搜索增强：多次重试仍未找到搜索选项面板，忽略链接功能在本视图中不可用',
                    this.searchDiagnostics()
                );
                continue;
            }
            this.pendingViews.set(view, attempts + 1);
            this.attachView(view as SearchViewLike);
        }
    }

    private attachView(view: SearchViewLike | null): void {
        if (!view || this.attachedViews.has(view)) return;
        const paramsEl = this.findParamsPanel(view);
        if (!paramsEl) {
            // 视图还没构造完：登记待重试，并只告警一次（此前每次事件都打印，会刷屏）
            if (!this.pendingViews.has(view)) this.pendingViews.set(view, 0);
            if (!this.warnedViews.has(view)) {
                this.warnedViews.add(view);
                console.warn(
                    '[LiteratureReader] 搜索增强：搜索视图尚未就绪，忽略链接开关将延后注入',
                    this.searchDiagnostics()
                );
            }
            return;
        }
        this.pendingViews.delete(view);
        this.attachedViews.set(view, false);

        // 与原生开关相同的 Setting + mod-toggle 结构，外观保持一致
        new Setting(paramsEl)
            .setName('忽略链接')
            .setClass('mod-toggle')
            .setClass(TOGGLE_CLASS)
            .addToggle((toggle) => {
                toggle.setValue(this.ignoreLinksEnabled());
                toggle.onChange((value) => void this.setIgnoreLinks(value, view));
                this.toggles.add(toggle);
            });

        this.watchPanelDetach(view, paramsEl);
        this.installQueryAccessor(view as QueryHolderView);
    }

    /**
     * 定位搜索选项面板。命中顺序：
     *  1. 视图自身的 searchParamsContainerEl（官方内部属性，与原生开关同容器）；
     *  2. 视图容器内按类名查 .search-params —— 个别版本该属性未挂出/被改名时仍能命中；
     *  3. 已在同一文档里注入过开关的面板（面板重建且视图引用未更新时复用，避免重复注入）。
     * 找不到（视图尚未构造完）时返回 null，由调用方登记重试。
     */
    private findParamsPanel(view: SearchViewLike): HTMLElement | null {
        const own = view.searchParamsContainerEl;
        // 只认「仍在文档里」的面板：核心搜索重建 DOM 后属性会指向脱离文档的旧节点
        if (own && this.isElement(own) && own.isConnected) return own;

        const container = view.containerEl;
        const doc = container?.ownerDocument ?? document;
        // 视图自带容器时只认容器内部：容器里没有面板说明这个视图还没构造完，
        // 若此时退到全文档查找，会误挂到另一个搜索视图的面板上
        if (container && this.isElement(container)) {
            return (container.querySelector(PARAMS_SELECTOR) as HTMLElement | null)
                ?? (container.querySelector('.' + TOGGLE_CLASS)?.parentElement as HTMLElement | null)
                ?? null;
        }

        // 视图没有容器（结构变化/自定义搜索视图）：退回全文档查找，并在已注入处复用
        const injected = doc.querySelector('.' + TOGGLE_CLASS) as HTMLElement | null;
        return (doc.querySelector(PARAMS_SELECTOR) as HTMLElement | null)
            ?? injected?.parentElement
            ?? null;
    }

    /** 跨 window（弹窗）安全的元素判定：不用当前 realm 的 HTMLElement 构造函数做 instanceof */
    private isElement(value: unknown): value is HTMLElement {
        return !!value && typeof value === 'object' && (value as Node).nodeType === 1;
    }

    /**
     * 面板若被核心搜索重建（DOM 整体重绘），已注入的开关会随之消失。
     * 用 MutationObserver 盯住当前面板：一旦脱离文档，立即重新定位并补挂。
     *
     * 只观察面板所在的叶子容器（而不是 doc.body + subtree）：面板被替换时，
     * childList 变动必然发生在它的某个祖先上，观察叶子容器同样能收到通知，
     * 却不必让引擎记录整个应用（含 CodeMirror 每次重绘）的全部 DOM 变动 ——
     * 后者每个已挂载的搜索视图都会注册一份，用户打字时持续被唤醒。
     */
    private watchPanelDetach(view: SearchViewLike, paramsEl: HTMLElement): void {
        const containerEl = this.isElement(view.containerEl) ? view.containerEl : null;
        const target = paramsEl.closest('.workspace-leaf-content') ?? containerEl;
        // 取不到容器时放弃观察：核心搜索重建后 attachAll 仍会经 layout-change 兜底补挂
        if (!target) return;

        const observer = new MutationObserver(() => {
            if (this.attachedViews.has(view) && !paramsEl.isConnected) {
                observer.disconnect();
                this.attachedViews.delete(view);
                this.attachView(view);
            }
        });
        observer.observe(target, { childList: true, subtree: true });
        // 与插件同生命周期：卸载时统一断开，避免观察器泄漏
        this.ctx.plugin.register(() => observer.disconnect());
    }

    /** 更新忽略链接开关并持久化；refreshView 为发起修改的视图，切换后立即重搜 */
    private async setIgnoreLinks(value: boolean, refreshView?: SearchViewLike): Promise<void> {
        this.ctx.getSettings().searchIgnoreLinks = value;
        await this.ctx.saveSettings();
        this.syncToggles(value);
        if (refreshView) this.refreshSearch(refreshView);
    }

    /** 同步所有已注入开关的显示状态（设置页修改后调用） */
    syncToggles(value: boolean): void {
        for (const toggle of this.toggles) {
            if (toggle.getValue() !== value) toggle.setValue(value);
        }
    }

    /** 搜索框有内容时重新执行搜索，让开关改动立即作用于当前结果 */
    private refreshSearch(view: SearchViewLike): void {
        const query = view.searchComponent?.getValue?.() ?? '';
        if (query && typeof view.startSearch === 'function') view.startSearch();
    }

    /**
     * 把视图的 searchQuery 包装为访问器：startSearch 内 this.searchQuery = 查询对象
     * 一执行就触发捕获，查询原型在逐文件匹配开始前完成包装，首次搜索即生效。
     */
    private installQueryAccessor(view: QueryHolderView): void {
        const self = this;
        const existing = view.searchQuery;
        delete view.searchQuery;
        Object.defineProperty(view, 'searchQuery', {
            configurable: true,
            enumerable: true,
            get(this: QueryHolderView) {
                return this.__lrSearchQuery;
            },
            set(this: QueryHolderView, value: unknown) {
                this.__lrSearchQuery = value;
                if (value && typeof value === 'object') {
                    self.captureQueryProto(Object.getPrototypeOf(value));
                }
            },
        });
        // 视图此前已搜索过（reload 场景）：回写以立即完成捕获
        this.attachedViews.set(view, true);
        view.searchQuery = existing;
    }

    /** 卸载时移除访问器并把当前查询对象还原为普通属性 */
    private uninstallQueryAccessor(view: QueryHolderView): void {
        const current = view.__lrSearchQuery;
        delete view.searchQuery;
        delete view.__lrSearchQuery;
        if (current !== undefined) view.searchQuery = current;
    }

    /** 包装查询类原型的 match(file, content)；返回是否本次新捕获 */
    private captureQueryProto(proto: object | null): boolean {
        if (this.wrappedQueryProto || !proto) return false;
        const queryProto = proto as { match?: MatchFn };
        if (typeof queryProto.match !== 'function') return false;
        this.wrappedQueryProto = proto;
        this.origMatch = queryProto.match;
        const self = this;
        queryProto.match = function (file: TFile, content: string) {
            const result = self.origMatch!.call(this, file, content) as Record<string, unknown> | null;
            if (
                self.ignoreLinksEnabled() &&
                result &&
                typeof result === 'object' &&
                file &&
                file.extension === 'md' &&
                typeof content === 'string'
            ) {
                try {
                    return filterLinkTargetMatches(result, content);
                } catch (e) {
                    console.warn('[LiteratureReader] 忽略链接：匹配过滤失败，按原样返回', e);
                }
            }
            return result;
        };
        return true;
    }
}

/**
 * 计算 md 文本中「链接目标」的字符区间（这些区间内的命中将被剔除）：
 *  - [[目标|别名]]：剔除 "[[目标|" 与 "]]"，别名文字保留可搜
 *  - [[目标]]：整段剔除
 *  - [文字](url)：剔除 "(url)"，文字保留
 */
function getLinkTargetSpans(text: string): Range[] {
    const spans: Range[] = [];
    const wikilink = /\[\[([^\]\n|]*)(\|[^\]\n]*)?\]\]/g;
    let m: RegExpExecArray | null;
    while ((m = wikilink.exec(text)) !== null) {
        if (m[2]) {
            // m[2] 形如 "|别名"，别名起点在 "[[" + 目标 + "|" 之后
            const aliasStart = m.index + 2 + m[1].length + 1;
            spans.push([m.index, aliasStart]);
            spans.push([aliasStart + (m[2].length - 1), m.index + m[0].length]);
        } else {
            spans.push([m.index, m.index + m[0].length]);
        }
    }
    const mdLink = /\]\(([^)\n]*)\)/g;
    while ((m = mdLink.exec(text)) !== null) {
        spans.push([m.index + 1, m.index + 1 + m[1].length + 2]);
    }
    return spans;
}

/** 从区间中剔除与链接目标重叠的部分；完全重叠时返回空数组 */
function subtractSpans(range: Range, spans: Range[]): Range[] {
    let parts: Range[] = [[range[0], range[1]]];
    for (const [s, e] of spans) {
        const next: Range[] = [];
        for (const [a, b] of parts) {
            if (e <= a || s >= b) {
                next.push([a, b]);
                continue;
            }
            if (s > a) next.push([a, s]);
            if (e < b) next.push([e, b]);
        }
        parts = next;
        if (!parts.length) break;
    }
    return parts;
}

/**
 * 过滤匹配结果中落在链接目标内的区间（原文不做任何改写，保证高亮/预览不错位）：
 *  - content 与 canvas-* 键的值为 [start, end][]，逐区间剔除目标部分；
 *  - filename（文件名匹配）与 properties（属性匹配）保持原样。
 * 过滤后没有任何键剩余时返回 null，该文件不再出现在结果里。
 */
function filterLinkTargetMatches(
    result: Record<string, unknown>,
    content: string
): Record<string, unknown> | null {
    const spans = getLinkTargetSpans(content);
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(result)) {
        const value = (result as Record<string, unknown>)[key];
        const isContentRanges = key === 'content' || key.startsWith('canvas-');
        if (!spans.length || !isContentRanges || !Array.isArray(value)) {
            out[key] = value;
            continue;
        }
        const filtered: Range[] = [];
        for (const item of value as unknown[]) {
            if (
                !Array.isArray(item) ||
                item.length < 2 ||
                typeof item[0] !== 'number' ||
                typeof item[1] !== 'number'
            ) {
                // 结构不符合预期时保守保留，避免破坏渲染
                filtered.push(item as Range);
                continue;
            }
            filtered.push(...subtractSpans([item[0], item[1]], spans));
        }
        if (filtered.length) out[key] = filtered;
    }
    return Object.keys(out).length ? out : null;
}
