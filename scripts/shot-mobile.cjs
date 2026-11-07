'use strict';

/**
 * 手机尺寸截图：把 dist/ 跑起来，按 390×844（iPhone 14 逻辑尺寸）渲染并截图。
 *
 * 用途：改手机布局前后对比，不靠猜。
 *
 * 用法：env -u ELECTRON_RUN_AS_NODE npx electron scripts/shot-mobile.cjs <输出png> [人数] [宽] [高]
 */

const { app, BrowserWindow } = require('electron');
const http = require('node:http');
const fsp = require('node:fs/promises');
const path = require('node:path');

const OUT = process.argv[2] || 'shot.png';
const PLAYERS = Number(process.argv[3] || 6);
const WIDTH = Number(process.argv[4] || 390);
const HEIGHT = Number(process.argv[5] || 844);
const DIST = path.join(process.cwd(), 'dist');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function serve() {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const rel = decodeURIComponent((req.url || '/').split('?')[0]).replace(/^\/+/, '') || 'index.html';
      const file = path.join(DIST, rel);
      try {
        const body = await fsp.readFile(file);
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
        res.end(body);
      } catch {
        try {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(await fsp.readFile(path.join(DIST, 'index.html')));
        } catch {
          res.writeHead(404);
          res.end('not found');
        }
      }
    });
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

app.whenReady().then(async () => {
  const port = await serve();
  const win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    // 必须可见：隐藏窗口不会重绘，capturePage 只会拿到旧帧
    show: true,
    frame: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  win.webContents.setZoomFactor(1);
  await win.loadURL(`http://127.0.0.1:${port}/`);
  await new Promise((r) => setTimeout(r, 800));
  // 跳过首次教程（否则弹窗挡住整个牌桌）
  await win.webContents.executeJavaScript(
    `localStorage.setItem('holdem-tutorial-seen-v1','1')`,
  );
  await win.webContents.reload();
  await new Promise((r) => setTimeout(r, 1000));

  const log = [];
  try {
    // 1) 设人数（下拉框 aria-label="玩家人数"）
    const setCount = await win.webContents.executeJavaScript(`(() => {
      const select = document.querySelector('select[aria-label="玩家人数"]');
      if (!select) return 'no-select';
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      setter.call(select, '${PLAYERS}');
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return select.value;
    })()`);
    log.push(`setCount=${setCount}`);
    await new Promise((r) => setTimeout(r, 400));

    // 2) 点「开始对局」
    const started = await win.webContents.executeJavaScript(`(() => {
      const all = [...document.querySelectorAll('button')].filter((b) => b.textContent.includes('开始对局'));
      if (all.length === 0) return 'no-start';
      for (const btn of all) {
        btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      }
      return 'clicked x' + all.length;
    })()`);
    log.push(`start=${started}`);
    await new Promise((r) => setTimeout(r, 1500));
    win.webContents.invalidate?.();
    await new Promise((r) => setTimeout(r, 300));
    const after = await win.webContents.executeJavaScript(`({
      lobby: !!document.querySelector('.lobby-card'),
      hint: document.querySelector('.turn-hint')?.textContent ?? null,
      handNo: document.querySelector('.table-chip')?.textContent ?? null,
      seats: document.querySelectorAll('.seat').length,
    })`);
    log.push('afterClick=' + JSON.stringify(after));

    // 2.4) 手机上设置是抽屉，开局后可能仍展开，先收起，否则挡住牌桌
    const collapsed = await win.webContents.executeJavaScript(`(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('收起'));
      if (!btn) return 'no-drawer';
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      return 'collapsed';
    })()`);
    log.push(`drawer=${collapsed}`);
    await new Promise((r) => setTimeout(r, 600));

    // 2.5) 可选：自动点「过牌 / 跟注」推进到翻牌，便于检查公共牌排版
    const STEPS = Number(process.env.STEPS || 0);
    for (let step = 0; step < STEPS; step++) {
      const clicked = await win.webContents.executeJavaScript(`(() => {
        const want = ['过牌', '跟注'];
        const btn = [...document.querySelectorAll('button')].find(
          (b) => !b.disabled && want.some((w) => b.textContent.includes(w)),
        );
        if (!btn) return null;
        btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        return btn.textContent.trim();
      })()`);
      if (!clicked) break;
      await new Promise((r) => setTimeout(r, 1400));
    }
    log.push('buttons=' + JSON.stringify(await win.webContents.executeJavaScript(
      `[...document.querySelectorAll('button')].filter(b=>!b.disabled).map(b=>b.textContent.trim()).slice(0,12)`,
    )));
    const boardCount = await win.webContents.executeJavaScript(
      `document.querySelectorAll('.board .card:not(.card--empty)').length`,
    );
    log.push(`boardCards=${boardCount}`);

    // 3) 探一下当前局面
    const probe = await win.webContents.executeJavaScript(`(() => {
      const stage = document.querySelector('.table-stage');
      const seats = [...document.querySelectorAll('.seat')].map((s) => {
        const r = s.getBoundingClientRect();
        return { name: s.querySelector('.seat__name')?.textContent, x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
      });
      const board = document.querySelector('.board')?.getBoundingClientRect();
      const pot = document.querySelector('.pot-banner')?.getBoundingClientRect();
      const stageRect = stage?.getBoundingClientRect();
      return {
        playerCount: document.querySelector('.table-panel')?.dataset.players,
        stage: stageRect ? { x: Math.round(stageRect.left), y: Math.round(stageRect.top), w: Math.round(stageRect.width), h: Math.round(stageRect.height) } : null,
        seats,
        board: board ? { x: Math.round(board.left), y: Math.round(board.top), w: Math.round(board.width), h: Math.round(board.height) } : null,
        pot: pot ? { x: Math.round(pot.left), y: Math.round(pot.top), w: Math.round(pot.width), h: Math.round(pot.height) } : null,
        docHeight: document.documentElement.scrollHeight,
        winHeight: window.innerHeight,
      };
    })()`);
    log.push(JSON.stringify(probe, null, 1));
  } catch (error) {
    log.push(`FAIL ${String(error && error.message ? error.message : error)}`);
  }

  const image = await win.webContents.capturePage();
  await fsp.writeFile(path.resolve(OUT), image.toPNG());
  console.log(log.join('\n'));
  console.log(`SHOT_SAVED ${path.resolve(OUT)}`);
  app.quit();
});
