import type { DataAdapter, Plugin } from 'obsidian';

/**
 * 回退用 pdfjs 库的最小接口。
 *
 * 这里刻意不 import pdfjs-dist 的类型：该库在运行时由 esbuild 拆成独立的
 * pdfjs-fallback.mjs 按需注入，主包只在 window 上持有它的引用，
 * 引入 `import type` 会把 pdfjs 类型体系（体积巨大）拉进编译面。
 */
export interface PdfjsLib {
  getDocument(options: Record<string, unknown>): { promise: Promise<any> };
  GlobalWorkerOptions: { workerSrc: string };
  /** 坐标工具（宿主自带的 pdf.js 暴露；插件回退副本未挂出，使用处需自行兜底） */
  Util?: { normalizeRect(rect: number[]): number[] };
}

declare global {
  interface Window {
    /** Obsidian 自带 pdf.js（宿主在打开 PDF 视图时注入，类型未公开） */
    pdfjsLib?: PdfjsLib;
    /** 回退用 pdfjs-fallback.mjs 求值后挂载的库引用 */
    __pdfReaderFallbackLib?: PdfjsLib;
  }
}

/** 回退库加载 Promise（同一进程只加载一次；失败后清空以便重试） */
let fallbackPdfjsPromise: Promise<PdfjsLib> | null = null;

/** 解析本插件所在目录名：优先用 manifest.dir（Obsidian 1.7+），并只取末段 */
function resolvePluginDir(pluginDir?: string | null): string {
  return (pluginDir ?? 'pdf-reader').split('/').pop() ?? 'pdf-reader';
}

/**
 * 取得回退用 pdfjs：注入独立打包的 pdfjs-fallback.mjs（含 worker 文件路径设置）。
 *
 * 只在 window.pdfjsLib 缺失时才会被调用，因此这里不再重复检查。
 * 并发调用共享同一个 Promise，避免重复注入 script 与重复求值 ~900KB 模块。
 */
export function loadFallbackPdfjs(
  pluginDirName: string,
  adapter: Pick<DataAdapter, 'getResourcePath'>,
  configDir = '.obsidian'
): Promise<PdfjsLib> {
  if (fallbackPdfjsPromise)
    return fallbackPdfjsPromise;

  // 配置目录名可被用户改写（vault.configDir），不能硬编码 .obsidian
  const base = `${configDir}/plugins/${resolvePluginDir(pluginDirName)}`;
  const libUrl = adapter.getResourcePath(`${base}/pdfjs-fallback.mjs`);
  const workerUrl = adapter.getResourcePath(`${base}/pdf.worker.min.mjs`);

  fallbackPdfjsPromise = (async () => {
    await new Promise<void>((resolve, reject) => {
      const script = document.head.createEl('script');
      script.type = 'module';
      script.src = libUrl;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error(`加载 pdfjs-fallback.mjs 失败: ${libUrl}`));
    });
    const lib = window.__pdfReaderFallbackLib;
    if (!lib?.getDocument) {
      throw new Error('pdfjs-fallback.mjs 已加载但未暴露 __pdfReaderFallbackLib');
    }
    lib.GlobalWorkerOptions.workerSrc = workerUrl;
    return lib;
  })();

  // 失败不缓存：下次调用可重试（否则一次加载失败会让该功能永久失效到插件重载）
  fallbackPdfjsPromise.catch(() => {
    fallbackPdfjsPromise = null;
  });
  return fallbackPdfjsPromise;
}

/**
 * 统一的 pdfjs 获取入口（文字批注高亮、截图裁剪嵌入、截图 OCR 共用）。
 *
 * 优先用 Obsidian 自带 pdf.js（与 PDF 视图的字体/CMap 行为一致）；
 * **宿主尚未暴露 window.pdfjsLib 时回退到插件自带的 pdfjs**。
 *
 * 这一点对「编辑模式」尤其关键：Obsidian 只在打开过 PDF 视图后才把 pdfjsLib 挂到 window 上，
 * 于是「笔记在编辑模式（Live Preview）下渲染截图嵌入」这条路径会在没有 PDF 标签页时
 * 拿到 undefined，报 `Cannot read properties of undefined (reading 'getDocument')`，
 * 嵌入区显示「PDF 截图加载失败」；阅读模式因为走的是已初始化的渲染器而看起来正常。
 */
export async function loadPdfjsLib(plugin: Plugin): Promise<PdfjsLib> {
  const appPdfjs = window.pdfjsLib;
  if (appPdfjs?.getDocument)
    return appPdfjs;
  return loadFallbackPdfjs(
    resolvePluginDir(plugin.manifest.dir),
    plugin.app.vault.adapter,
    plugin.app.vault.configDir
  );
}
