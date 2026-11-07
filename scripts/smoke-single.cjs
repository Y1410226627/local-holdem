'use strict';

/**
 * 单文件 HTML 的 file:// 冒烟测试。
 *
 * 为什么需要单独测：单文件版最终是让用户**双击**打开的，走的是 file:// 协议，
 * 而不是本地 HTTP。file:// 下浏览器对 ES module、CORS、localStorage 的限制都不一样，
 * 光看构建成功不能说明能跑。
 *
 * 用法：env -u ELECTRON_RUN_AS_NODE npx electron scripts/_test-single.cjs <html路径> <结果输出路径>
 */

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const htmlPath = path.resolve(process.argv[2] || 'dist-single/index.html');
const outPath = process.argv[3] || path.join(require('node:os').tmpdir(), 'single-smoke.txt');
const lines = [];

function log(line) {
  lines.push(line);
  try {
    fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
  } catch {
    /* 忽略 */
  }
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });

  // 抓渲染进程的 console 与加载失败，ES module 被拦时这里会有明确报错
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) log(`CONSOLE_ERR ${message}`);
  });
  win.webContents.on('did-fail-load', (_event, code, description, url) => {
    log(`DID_FAIL_LOAD ${code} ${description} ${url}`);
  });

  try {
    await win.loadFile(htmlPath);
    log('LOADED');
    const probe = await win.webContents.executeJavaScript(`(() => {
      const root = document.getElementById('root');
      return {
        title: document.title,
        rootChildren: root ? root.children.length : -1,
        textLength: document.body ? document.body.innerText.length : -1,
        scriptTags: document.querySelectorAll('script').length,
        inlineModule: [...document.querySelectorAll('script[type=module]')].every(s => !s.src),
        localStorageOk: (() => { try { localStorage.setItem('__t','1'); localStorage.removeItem('__t'); return true; } catch { return false; } })(),
      };
    })()`);
    log(`PROBE ${JSON.stringify(probe)}`);
    log(probe.rootChildren > 0 && probe.textLength > 0 ? 'SINGLE_OK' : 'SINGLE_EMPTY');
  } catch (error) {
    log(`FAIL ${String(error && error.message ? error.message : error)}`);
  }

  setTimeout(() => app.quit(), 300);
});
