/**
 * 单文件构建配置：把整个游戏打成一个 .html，双击就能用浏览器打开玩。
 *
 * 用途：给没有电脑基础、且用 Mac / Linux 的人。exe 只能在 Windows 跑，
 * 而 macOS 的 .app 必须在 Mac 上打包，所以「一个 HTML 文件」是唯一
 * 能在这里直接交付、且三大系统通用的形态。
 *
 * 和正常构建（vite.config.ts）的区别：
 * - 用 viteSingleFile 把 JS / CSS 全部内联进 index.html；
 * - `base: './'` + 把 assetsInlineLimit 拉满，保证没有任何外部文件引用
 *   （file:// 下相对路径能解析，但绝对路径 /assets/... 会失效）；
 * - 输出到 dist-single/，不影响 dist/ 与安卓包。
 *
 * 注意：这个配置不参与测试（测试用 vite.config.ts）。
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

export default defineConfig({
  plugins: [react(), viteSingleFile()],
  // file:// 下没有 origin，只能用相对路径
  base: './',
  build: {
    outDir: 'dist-single',
    emptyOutDir: true,
    // 把所有资源（图片、字体）都转成 base64 内联，避免任何外部请求
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
    // 目标放低一档，兼容旧一点的 Safari
    target: 'es2019',
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
});
