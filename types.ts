import type { Plugin, TFile } from 'obsidian';
import type { ReadNoteOptions } from './modules/noteContentCache';
import type { PendingRename, TagDef, TagEntry } from './modules/tagVocabulary';
import { DEFAULT_NOTE_NAME_TEMPLATE } from './modules/noteNaming';

/**
 * DeepSeek 浮动窗口几何信息
 * 用户拖拽移动或拖动边缘调整大小后持久化；
 * null 表示未调整过，沿用 styles.css 的默认位置与尺寸
 */
export interface WindowGeometry {
    left: number;
    top: number;
    width: number;
    height: number;
}

/** DeepSeek 打开方式：浮动窗口 / 工作区标签页 */
export type DeepSeekOpenMode = 'floating' | 'tab';

/**
 * 合并插件的统一设置接口
 * 包含 PDF 阅读与 DeepSeek 浮动窗口两部分配置
 * 以及截图 OCR 批注（LM Studio 视觉模型）配置
 */
/** Markdown 批注链接与来源笔记 `==高亮==` 的配对记录；用于删除「定位」链接时同步撤销高亮 */
export interface MarkdownAnnotationRecord {
    /** 稳定 id，仅用于记录配对 */
    id: string;
    /** 目标笔记路径（写入「定位」链接的那篇笔记） */
    targetPath: string;
    /** 来源笔记路径（被 `==` 高亮的 Markdown 文件） */
    sourcePath: string;
    /** 目标笔记中由本插件生成的原文链接，例如 `[[来源#标题|定位]]` */
    linkText: string;
    /** 链接中的来源子路径（如 `#标题`）；来源文件重命名后用于重新生成链接 */
    sourceSubpath: string;
    /** 链接显示文字（默认「定位」）；来源文件重命名后用于重新生成链接 */
    linkLabel: string;
    /** 创建时链接前侧的上下文窗口，用于在多个相同链接间定位具体记录 */
    targetBefore: string;
    /** 创建时链接后侧的上下文窗口，用于在多个相同链接间定位具体记录 */
    targetAfter: string;
    /** 来源笔记中 `==...==` 内部的原选中文字 */
    highlightText: string;
    /** 来源笔记中第一个 `==` 的绝对偏移；内容变动时作为就近匹配依据 */
    sourceStartOffset: number;
    /** 创建时间，重复链接匹配失效时保留更早的记录 */
    createdAt: number;
}

export interface PluginSettings {
    /** 阅读笔记存放文件夹（相对 vault 根目录） */
    readingNoteFolder: string;
    /** DeepSeek 嵌入网页地址 */
    deepseekUrl: string;
    /** DeepSeek 默认打开方式（Ribbon 图标与切换命令）：浮动窗口或工作区标签页 */
    deepseekOpenMode: DeepSeekOpenMode;
    /** LM Studio 服务器地址（OpenAI 兼容接口） */
    ocrServerUrl: string;
    /** LM Studio API Key（开启 Require Authentication 时必填） */
    ocrApiKey: string;
    /** OCR 模型名（空 = 自动选择服务器列表内视觉模型，推荐 paddleocr-vl-1.6） */
    ocrModel: string;
    /** 单次 OCR 请求超时（秒） */
    ocrRequestTimeoutSec: number;
    /** 单次识别请求最大输出令牌 */
    ocrMaxTokens: number;
    /** OCR 提示词（PaddleOCR-VL 用任务词如 OCR:） */
    ocrPrompt: string;
    /** 批注持久高亮填充色（#RRGGBB），文字批注与 OCR 区域高亮共用 */
    highlightColor: string;
    /** 批注持久高亮不透明度（0-1） */
    highlightOpacity: number;
    /** 三种批注方式是否默认附带原文/定位（「附带原文」按钮的初始状态，切换按钮会同步保存） */
    annotationIncludeOriginalText: boolean;
    /** 批注回链 PDF 的链接显示文字（写入用户笔记正文） */
    annotationLinkLabel: string;
    /** 批注 callout 末尾的提示行（写入用户笔记正文） */
    annotationPromptLine: string;
    /** 阅读笔记文件名模板，{name} 为 PDF 文件名（不含扩展名） */
    readingNoteNameTemplate: string;
    /** 新建阅读笔记的正文模板 */
    readingNoteBodyTemplate: string;
    /** OCR 截图放大目标短边像素（区域短边不足时等比放大；0 = 关闭放大） */
    ocrMinSidePx: number;
    /** OCR 截图放大的倍率上限 */
    ocrMaxUpscaleFactor: number;
    /** 是否清洗 OCR 输出（去 HTML/LaTeX 包装等；关闭 = 原样保留模型输出） */
    ocrSanitizeOutput: boolean;
    /** 是否在文件管理器为已有阅读笔记的文献（PDF 或 md 文献）显示小图标 */
    fileMarkerEnabled: boolean;
    /** 状态栏字数统计修正：图片/链接语法不计词（[[目标|别名]] 只计别名，嵌入与 URL 移除） */
    wordCountFixEnabled: boolean;
    /** 搜索增强-忽略链接：核心搜索时忽略 [[链接目标|别名]] 的目标文本（含 PDF 路径与定位参数） */
    searchIgnoreLinks: boolean;
    /**
     * 快速标签-标签定义列表（稳定 id + 名称 + 描述）。
     * 这是标签的唯一真源，在插件设置面板的「标签管理」中逐行编辑。
     * id 创建后**永不改变**，因此改名是用户在界面上改动的「记录」，而非对比新旧文本的「推断」。
     */
    quickTags: TagDef[];
    /** 快速标签-待同步到笔记的改名（用户改名时登记；同步或撤销后清空） */
    pendingTagRenames: PendingRename[];
    /** 快速标签-是否在每个 PDF 视图工具条注入「标签」按钮（嫌工具条拥挤可关闭，仅用快捷键） */
    quickTagToolbarButton: boolean;
    /** Markdown 批注链接与来源高亮的配对记录（删除链接时同步撤销 `==`） */
    markdownAnnotationRecords: MarkdownAnnotationRecord[];
    /** @deprecated 上一版的文本框存储，仅用于首次迁移到 quickTags，之后不再写入 */
    quickTagText?: string;
    /** @deprecated 上一版的同步快照，已被 pendingTagRenames 取代，之后不再写入 */
    quickTagApplied?: TagEntry[];
    /** DeepSeek 浮动窗口几何（拖拽/缩放后自动保存） */
    deepseekWindowGeometry: WindowGeometry | null;
}

export const DEFAULT_SETTINGS: PluginSettings = {
    readingNoteFolder: 'ReadingNotes',
    deepseekUrl: 'https://chat.deepseek.com',
    deepseekOpenMode: 'floating',
    ocrServerUrl: 'http://127.0.0.1:1234',
    ocrApiKey: '',
    ocrModel: 'paddleocr-vl-1.6',
    ocrRequestTimeoutSec: 120,
    ocrMaxTokens: 8192,
    ocrPrompt: 'OCR:',
    // 与旧版本遗留 data.json 及 README 承诺一致的经典黄色高亮
    highlightColor: '#FFFF00',
    highlightOpacity: 0.4,
    annotationIncludeOriginalText: false,
    annotationLinkLabel: '定位',
    annotationPromptLine: '> 笔记：',
    readingNoteNameTemplate: DEFAULT_NOTE_NAME_TEMPLATE,
    // 默认为空：新建阅读笔记正文仅含 frontmatter，不留预设板块
    readingNoteBodyTemplate: '',
    ocrMinSidePx: 512,
    ocrMaxUpscaleFactor: 4,
    ocrSanitizeOutput: true,
    fileMarkerEnabled: true,
    wordCountFixEnabled: true,
    searchIgnoreLinks: false,
    quickTags: [],
    pendingTagRenames: [],
    quickTagToolbarButton: true,
    markdownAnnotationRecords: [],
    deepseekWindowGeometry: null,
};

/**
 * PDF 选中文字的定位信息
 * 用于生成回到原文的精确链接
 * page 为 null 表示定位失败，批注将不附带原文链接
 */
export interface SavedSelectionInfo {
    text: string;
    page: number | null;
    beginIndex: number;
    beginOffset: number;
    endIndex: number;
    endOffset: number;
    /** 截图 OCR 批注的归一化矩形（0-1，相对页面尺寸），仅 beginIndex<0 时使用 */
    ocrRect?: { x: number; y: number; w: number; h: number };
}

/**
 * 模块基类约定
 * 每个功能模块需实现 load / unload 生命周期
 */
export interface PluginModule {
    load(): void;
    unload(): void;
}

/**
 * 待上传文件的数据包
 * 用于将当前阅读的文件以二进制形式上传到 DeepSeek 聊天框
 */
export interface FileUploadData {
    /** 文件二进制内容 */
    data: ArrayBuffer;
    /** 文件名（含扩展名） */
    name: string;
    /** MIME 类型，如 application/pdf、text/markdown */
    mimeType: string;
}

/**
 * 模块构造器接收的上下文
 * 通过该对象访问插件实例与设置，避免直接耦合
 */
export interface ModuleContext {
    plugin: Plugin;
    getSettings: () => PluginSettings;
    saveSettings: () => Promise<void>;
    /** 获取当前活动文件的二进制数据用于上传，无可用文件时返回 null */
    getCurrentFileForUpload?: () => Promise<FileUploadData | null>;
    /**
     * 读取笔记内容（编辑器缓冲优先 + 短 TTL 共享缓存）。
     * 高亮与跳转模块的索引重建共用，避免一次批注触发 4 次重复读取；
     * 未注入时调用方回退为各自的读取实现
     */
    readNoteContent?: (file: TFile, opts?: ReadNoteOptions) => Promise<string>;
}
