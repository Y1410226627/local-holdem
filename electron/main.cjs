'use strict';

/**
 * Electron 主进程：把打包好的 dist/ 用本地 HTTP 服务跑起来，再用独立窗口打开。
 *
 * 为什么不用 file:// 直接加载：
 * Vite 的产物默认是绝对路径（`/assets/xxx.js`），file:// 下会解析到磁盘根目录，页面直接白屏。
 * 起一个只监听 127.0.0.1 的本地服务，路径语义就和浏览器里完全一致，也不需要改 vite 的 base
 * （改了会影响安卓包）。
 *
 * 端口用 0 让系统分配，避免和用户机器上其它程序抢端口。
 */

const { app, BrowserWindow, Menu, shell, dialog } = require('electron');
const nodeFs = require('node:fs');

/**
 * 冒烟追踪：把启动阶段追加写入 HOLDEM_SMOKE_OUT。
 * Windows 的 GUI 子系统不把 stdout 接回父进程，所以只能靠文件观察启动到哪一步。
 */
function trace(stage, extra) {
  const target = process.env.HOLDEM_SMOKE_OUT;
  if (!target) return;
  try {
    nodeFs.appendFileSync(target, `${stage}${extra ? ' ' + JSON.stringify(extra) : ''}\n`, 'utf8');
  } catch {
    /* 追踪失败不影响主流程 */
  }
}
trace('BOOT', { electron: process.versions.electron, dirname: __dirname });
const http = require('node:http');
const fsp = require('node:fs/promises');
const path = require('node:path');

const DIST_DIR = path.join(__dirname, '..', 'dist');
const ICON_PATH = path.join(DIST_DIR, 'icons', 'icon-512.png');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
};

/** 把请求路径映射到 dist 下的真实文件；拒绝路径穿越。 */
function resolveRequestPath(rawUrl) {
  let decoded;
  try {
    decoded = decodeURIComponent((rawUrl || '/').split('?')[0].split('#')[0]);
  } catch {
    return null;
  }
  const normalized = path.normalize(decoded).replace(/^[/\\]+/, '');
  if (normalized.split(/[/\\]/).includes('..')) return null;
  const target = path.join(DIST_DIR, normalized || 'index.html');
  const relative = path.relative(DIST_DIR, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return target;
}

async function readIfFile(filePath) {
  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) return null;
    return await fsp.readFile(filePath);
  } catch {
    return null;
  }
}

function startServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        let filePath = resolveRequestPath(req.url);
        let body = filePath ? await readIfFile(filePath) : null;
        // 兜底：任何找不到的路径都回 index.html（本项目没有前端路由，但保证不会白屏）
        if (!body) {
          filePath = path.join(DIST_DIR, 'index.html');
          body = await readIfFile(filePath);
        }
        if (!body) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('未找到页面资源，请重新安装。');
          return;
        }
        const ext = path.extname(filePath || '').toLowerCase();
        res.writeHead(200, {
          'Content-Type': MIME[ext] || 'application/octet-stream',
          // HTML 不缓存（保证升级后立刻生效），静态资源长缓存
          'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
        });
        res.end(body);
      } catch {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('本地服务出错。');
      }
    });
    server.on('error', reject);
    // 端口 0 = 由系统分配空闲端口，避免和用户机器上其它程序抢端口
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}/`, close: () => server.close() });
    });
  });
}

/** @type {import('electron').BrowserWindow | null} */
let mainWindow = null;
/** @type {{ close: () => void } | null} */
let serverHandle = null;

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#0b3d2e',
    title: '德州扑克',
    icon: ICON_PATH,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      // 这是一个纯网页游戏，不需要 Node 能力——关掉能显著降低风险
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      spellcheck: false,
    },
  });

  // 去掉菜单栏（Alt 也呼不出来），游戏不需要
  Menu.setApplicationMenu(null);

  mainWindow.once('ready-to-show', () => mainWindow && mainWindow.show());

  // 外部链接交给系统浏览器，不在游戏窗口里打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (serverHandle && url.startsWith(serverHandle.url)) return;
    event.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  const { url } = await startServer().then((handle) => {
    serverHandle = handle;
    return handle;
  });
  trace('SERVER_UP', { url });

  // 无头冒烟模式：打包/发布前用它验证「服务能起来 + 页面真的渲染了」，
  // 不需要人工看窗口。用法：HOLDEM_SMOKE=1 npx electron .
  if (process.env.HOLDEM_SMOKE === '1') {
    mainWindow.webContents.once('did-finish-load', async () => {
      trace('DID_FINISH_LOAD');
      try {
        const probe = await mainWindow.webContents.executeJavaScript(
          `(() => {
            const root = document.getElementById('root');
            return {
              title: document.title,
              rootChildren: root ? root.children.length : -1,
              textLength: document.body ? document.body.innerText.length : -1,
              hasCanvas: Boolean(document.querySelector('canvas')),
            };
          })()`,
        );
        const ok = probe.rootChildren > 0 && probe.textLength > 0;
        const line = `${ok ? 'SMOKE_OK' : 'SMOKE_EMPTY_PAGE'} ${JSON.stringify(probe)}`;
        console.log(line);
        // Windows 的 GUI 子系统不会把 stdout 接回父进程控制台，
        // 所以冒烟结果同时写文件，供自动化验证读取。
        trace('SMOKE_RESULT', { line });
      } catch (error) {
        const message = String(error && error.message ? error.message : error);
        console.log('SMOKE_FAIL', message);
        trace('SMOKE_FAIL', { message });
      }
      setTimeout(() => app.quit(), 400);
    });
  }

  await mainWindow.loadURL(url);
}

// 只允许开一个实例：重复双击时把已有窗口拉到前面
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    trace('READY', { distDir: DIST_DIR });
    try {
      await fsp.access(path.join(DIST_DIR, 'index.html'));
      trace('DIST_OK');
    } catch {
      trace('DIST_MISSING', { distDir: DIST_DIR });
      dialog.showErrorBox('安装不完整', '找不到游戏资源目录，请重新安装。');
      app.quit();
      return;
    }
    try {
      await createWindow();
    } catch (error) {
      dialog.showErrorBox('启动失败', String(error && error.message ? error.message : error));
      app.quit();
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) void createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (serverHandle) serverHandle.close();
    app.quit();
  });
}
