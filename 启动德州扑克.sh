#!/usr/bin/env bash
# 本地人机德州扑克 · 一键启动（macOS / Linux 终端版）
#
# 用法：
#   bash 启动德州扑克.sh              # 启动本地服务并打开浏览器
#   bash 启动德州扑克.sh --no-open    # 只启动本地服务，不打开浏览器
#
# macOS 用户也可以直接双击「启动德州扑克.command」。
set -u

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR" || exit 1

NO_OPEN=0
if [ "${1:-}" = "--no-open" ]; then
  NO_OPEN=1
fi

echo "============================================"
echo "   本地人机德州扑克  一键启动"
echo "============================================"
echo

if ! command -v node >/dev/null 2>&1; then
  echo "[错误] 未找到 Node.js，请先安装 Node.js 22.12 或更高版本（推荐 24 LTS）："
  echo "       https://nodejs.org/zh-cn/download"
  echo "       macOS 也可以用 Homebrew：brew install node"
  echo
  read -r -p "按回车键退出..." _ || true
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "[错误] 未找到 npm，请重新安装 Node.js。"
  echo
  read -r -p "按回车键退出..." _ || true
  exit 1
fi

if ! node scripts/setup.mjs --check >/dev/null 2>&1; then
  echo "[错误] 运行环境不满足要求（需要 Node.js 22.12+，推荐 24 LTS）。"
  echo "       请先双击「一键安装.command」，或运行 bash 一键安装.sh 完成配置。"
  echo
  read -r -p "按回车键退出..." _ || true
  exit 1
fi

open_browser() {
  if command -v open >/dev/null 2>&1; then
    open "http://localhost:5173" >/dev/null 2>&1 || true
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "http://localhost:5173" >/dev/null 2>&1 || true
  else
    echo "       请手动在浏览器打开：http://localhost:5173"
  fi
}

# 服务已在运行 → 只打开浏览器
if command -v curl >/dev/null 2>&1 && curl -fsS --max-time 2 "http://localhost:5173/" >/dev/null 2>&1; then
  echo "[提示] 检测到本地服务已经在运行：http://localhost:5173"
  if [ "$NO_OPEN" -eq 0 ]; then
    echo "       正在打开浏览器..."
    open_browser
  else
    echo "       未打开浏览器（--no-open）。"
  fi
  exit 0
fi

if [ ! -d node_modules ]; then
  echo "[1/2] 首次运行，正在安装依赖（需要联网，约 1-2 分钟）..."
  if ! npm install --no-audit --no-fund; then
    echo
    echo "[错误] 依赖安装失败，请检查网络后重新运行本脚本。"
    echo "       国内网络可先执行：npm config set registry https://registry.npmmirror.com"
    echo
    read -r -p "按回车键退出..." _ || true
    exit 1
  fi
  echo "依赖安装完成。"
  echo
fi

echo "[2/2] 正在启动本地服务，地址：http://localhost:5173"
echo "       关闭本窗口或按 Ctrl+C 可停止服务。"
echo
if [ "$NO_OPEN" -eq 0 ]; then
  exec npm run dev -- --open
else
  exec npm run dev
fi
