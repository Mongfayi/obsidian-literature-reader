import type { Plugin } from 'obsidian';

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
    /** OCR 模型名（空 = 自动选择服务器列表内模型） */
    ocrModel: string;
    /** 单次 OCR 请求超时（秒） */
    ocrRequestTimeoutSec: number;
    /** 单次识别请求最大输出令牌 */
    ocrMaxTokens: number;
    /** OCR 提示词（PaddleOCR-VL 用任务词如 OCR:） */
    ocrPrompt: string;
}

export const DEFAULT_SETTINGS: PluginSettings = {
    readingNoteFolder: 'ReadingNotes',
    deepseekUrl: 'https://chat.deepseek.com',
    ocrServerUrl: 'http://127.0.0.1:1234',
    ocrModel: 'paddleocr-vl-1.6',
    ocrRequestTimeoutSec: 120,
    ocrMaxTokens: 8192,
    ocrPrompt: 'OCR:',
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
