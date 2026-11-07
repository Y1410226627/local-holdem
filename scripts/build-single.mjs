/**
 * 把游戏打成**一个** .html 文件，双击即可用浏览器打开（Windows / macOS / Linux 通用）。
 *
 * 为什么需要它：exe 只能在 Windows 跑，而 macOS 的 .app 必须在 Mac 上打包。
 * 「单文件 HTML」是唯一能跨三大系统、且不需要安装任何运行时的形态。
 *
 * 产出：release/德州扑克.html
 *
 * 做三件事：
 * 1) 用 vite.config.single.ts 构建（JS / CSS 全部内联）；
 * 2) 删掉两个指向外部文件的 <link>（manifest / apple-touch-icon）——
 *    file:// 下它们会 404，虽然无害，但删掉才是真正的「单文件」；
 * 3) 复制到 release/ 并改成人能看懂的文件名。
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const root = process.cwd();
const source = join(root, 'dist-single', 'index.html');
const outputDir = join(root, 'release');
const output = join(outputDir, '德州扑克.html');

console.log('[single] 构建中…');
// 直接调 vite 的入口，不走 npx：Windows 上 npx.cmd 在部分环境里 spawn 会 ENOENT
execFileSync(
  process.execPath,
  [join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--config', 'vite.config.single.ts'],
  { cwd: root, stdio: 'inherit' },
);

let html = readFileSync(source, 'utf8');
const before = html.length;

// 这两个 <link> 指向 file:// 下不存在的文件；删掉才是真正的单文件
html = html
  .replace(/\s*<link[^>]*rel="manifest"[^>]*>\s*/i, '\n')
  .replace(/\s*<link[^>]*rel="apple-touch-icon"[^>]*>\s*/i, '\n');

if (/<link[^>]*rel="(manifest|apple-touch-icon)"/i.test(html)) {
  throw new Error('外部引用没清理干净，请检查 index.html 的 <link> 标签');
}

mkdirSync(outputDir, { recursive: true });
writeFileSync(output, html, 'utf8');

console.log(`[single] 完成：${output}`);
console.log(`[single] 体积：${(html.length / 1024).toFixed(0)} KB（清理前 ${(before / 1024).toFixed(0)} KB）`);
console.log('[single] 用法：双击打开，或拖进浏览器窗口。不需要安装 Node，不需要联网。');
