import type { Plugin } from 'obsidian';

/**
 * 合并插件的统一设置接口
 * 包含 PDF 阅读与 DeepSeek 浮动窗口两部分配置
 */
export interface PluginSettings {
    /** 阅读笔记存放文件夹（相对 vault 根目录） */
    readingNoteFolder: string;
    /** DeepSeek 嵌入网页地址 */
    deepseekUrl: string;
}

export const DEFAULT_SETTINGS: PluginSettings = {
    readingNoteFolder: 'ReadingNotes',
    deepseekUrl: 'https://chat.deepseek.com',
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
