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
    const workerResult = await esbuild.build({
        entryPoints: [path.join(pluginDir, 'node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs')],
        bundle: true,
        format: 'iife',
        write: false,
        logLevel: 'info',
    });

    const workerCode = workerResult.outputFiles[0].text;

    await esbuild.build({
        entryPoints: [path.join(pluginDir, 'main.ts')],
        bundle: true,
        external: ['obsidian', 'electron', 'fs', 'path'],
        format: 'cjs',
        target: 'es2020',
        logLevel: 'info',
        sourcemap: prod ? false : 'inline',
        treeShaking: true,
        outfile: path.join(pluginDir, 'main.js'),
        define: {
            'WORKER_CODE': JSON.stringify(workerCode),
        },
    });

    const cmapSrc = path.join(pluginDir, 'node_modules/pdfjs-dist/cmaps');
    const cmapDest = path.join(pluginDir, 'cmaps');
    copyDirRecursive(cmapSrc, cmapDest);
    const fileCount = fs.readdirSync(cmapDest).length;
    console.log(`CMap files copied to cmaps/ (${fileCount} files)`);
}

build().catch(() => process.exit(1));
