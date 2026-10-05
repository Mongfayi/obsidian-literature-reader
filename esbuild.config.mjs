import esbuild from 'esbuild';
import process from 'process';
import path from 'path';
import fs from 'fs';

const prod = process.argv[2] === 'production';
const pluginDir = process.cwd();

function copyDirRecursive(src, dest) {
    if (!fs.existsSync(dest)) {
        fs.mkdirSync(dest, { recursive: true });
    }
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        if (entry.isDirectory()) {
            copyDirRecursive(srcPath, destPath);
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
    }
}

async function build() {
    // 回退用 pdfjs 主库拆为独立 ESM 文件（~1.5MB），首次回退时由 <script type="module"> 按需加载；
    // footer 在模块作用域内把需要的导出挂到 window，供主包检测模块已求值完成
    await esbuild.build({
        entryPoints: [path.join(pluginDir, 'node_modules/pdfjs-dist/legacy/build/pdf.mjs')],
        bundle: true,
        format: 'esm',
        target: 'es2020',
        logLevel: 'info',
        outfile: path.join(pluginDir, 'pdfjs-fallback.mjs'),
        footer: {
            js: 'window.__pdfReaderFallbackLib = { getDocument, GlobalWorkerOptions, VerbosityLevel };',
        },
    });

    // pdf worker 同样落盘为独立文件，避免 1.4MB 字符串内联进 main.js 常驻内存
    fs.copyFileSync(
        path.join(pluginDir, 'node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs'),
        path.join(pluginDir, 'pdf.worker.min.mjs')
    );

    await esbuild.build({
        entryPoints: [path.join(pluginDir, 'main.ts')],
        bundle: true,
        external: ['obsidian', 'electron', 'fs', 'path', '@codemirror/state', '@codemirror/view'],
        format: 'cjs',
        target: 'es2020',
        logLevel: 'info',
        sourcemap: prod ? false : 'inline',
        treeShaking: true,
        outfile: path.join(pluginDir, 'main.js'),
    });

    const cmapSrc = path.join(pluginDir, 'node_modules/pdfjs-dist/cmaps');
    const cmapDest = path.join(pluginDir, 'cmaps');
    copyDirRecursive(cmapSrc, cmapDest);
    const fileCount = fs.readdirSync(cmapDest).length;
    console.log(`CMap files copied to cmaps/ (${fileCount} files)`);
}

build().catch(() => process.exit(1));
