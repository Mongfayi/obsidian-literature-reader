import type { Plugin } from 'obsidian';
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

/**
 * 合并插件的统一设置接口
 * 包含 PDF 阅读与 DeepSeek 浮动窗口两部分配置
 * 以及截图 OCR 批注（LM Studio 视觉模型）配置
 */
export interface PluginSettings {
    /** 阅读笔记存放文件夹（相对 vault 根目录） */
    readingNoteFolder: string;
    /** DeepSeek 嵌入网页地址 */
    deepseekUrl: string;
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
    /** 文字批注是否默认附带原文（「附带原文」按钮的初始状态，切换按钮会同步保存） */
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
    /** 是否在文件管理器为已有阅读笔记的 PDF 显示小图标 */
    fileMarkerEnabled: boolean;
    /** DeepSeek 浮动窗口几何（拖拽/缩放后自动保存） */
    deepseekWindowGeometry: WindowGeometry | null;
}

export const DEFAULT_SETTINGS: PluginSettings = {
    readingNoteFolder: 'ReadingNotes',
    deepseekUrl: 'https://chat.deepseek.com',
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
    readingNoteBodyTemplate: '## 信息\n\n## 疑问',
    ocrMinSidePx: 512,
    ocrMaxUpscaleFactor: 4,
    ocrSanitizeOutput: true,
    fileMarkerEnabled: true,
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
}
