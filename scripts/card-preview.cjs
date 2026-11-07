'use strict';

/**
 * 卡牌排版预览：用**真实构建产物里的 CSS** 渲染各种尺寸的牌，按手机宽度截图。
 * 目的：直接验证「花色盖住字母」「牌面被裁」这类纯排版问题，不用去驱动整个 App。
 *
 * 用法：env -u ELECTRON_RUN_AS_NODE npx electron scripts/card-preview.cjs <输出png> [宽]
 */
const { app, BrowserWindow } = require('electron');
const fsp = require('node:fs/promises');
const path = require('node:path');

const OUT = process.argv[2] || 'cards.png';
const WIDTH = Number(process.argv[3] || 390);

const RANK = { 14: 'A', 13: 'K', 12: 'Q', 11: 'J', 10: '10', 9: '9', 8: '8', 7: '7' };
const SUIT = { s: '♠', h: '♥', d: '♦', c: '♣' };

function card(rank, suit, size) {
  const red = suit === 'h' || suit === 'd';
  return `<div class="card card--${size} ${red ? 'card--red' : 'card--black'}">
    <span class="card__corner card__corner--top">
      <span class="card__rank">${RANK[rank]}</span>
      <span class="card__suit">${SUIT[suit]}</span>
    </span>
    <span class="card__pip" aria-hidden="true">${SUIT[suit]}</span>
    <span class="card__corner card__corner--bottom" aria-hidden="true">
      <span class="card__rank">${RANK[rank]}</span>
      <span class="card__suit">${SUIT[suit]}</span>
    </span>
  </div>`;
}

app.whenReady().then(async () => {
  const assets = path.join(process.cwd(), 'dist', 'assets');
  const files = await fsp.readdir(assets);
  const css = files.find((f) => f.startsWith('index-') && f.endsWith('.css'));
  if (!css) throw new Error('找不到构建产物 CSS，请先 npm run build');

  const board = [card(14, 's', 'lg'), card(13, 'h', 'lg'), card(10, 'd', 'lg'), card(9, 'c', 'lg'), card(7, 's', 'lg')];
  const seat = [card(14, 'h', 'sm'), card(11, 'c', 'sm')];
  const hand = [card(13, 'd', 'sm'), card(10, 'c', 'sm')];

  const html = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="file://${path.join(assets, css).replace(/\\/g, '/')}">
<style>
  body { margin:0; padding:16px; background:#0b3d2e; font-family:system-ui,sans-serif; }
  h3 { color:#cfe5d9; font-size:12px; margin:16px 0 8px; letter-spacing:.08em; }
  .row { display:flex; gap:6px; align-items:center; }
  .board-slot { padding:10px 6px; background:rgba(0,0,0,.18); border-radius:8px; }
</style></head><body>
  <h3>公共牌（card--lg，手机宽度下的 clamp）</h3>
  <div class="row board-slot">${board.join('')}</div>
  <h3>我的底牌（card--sm，座位内）</h3>
  <div class="row">${hand.join('')}</div>
  <h3>对手牌背 / 座位牌（card--sm）</h3>
  <div class="row">${seat.join('')}</div>
</body></html>`;

  const tmp = path.join(process.cwd(), '.card-preview.html');
  await fsp.writeFile(tmp, html, 'utf8');

  const win = new BrowserWindow({ width: WIDTH, height: 420, show: true, frame: false });
  await win.loadFile(tmp);
  await new Promise((r) => setTimeout(r, 700));
  await fsp.writeFile(path.resolve(OUT), (await win.webContents.capturePage()).toPNG());
  console.log(`SHOT_SAVED ${path.resolve(OUT)}`);
  app.quit();
});
