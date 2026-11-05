#!/usr/bin/env bash
# 本地人机德州扑克 · 一键配置（macOS / Linux 终端版）
#
# 用法：
#   bash 一键安装.sh                # 安装依赖 + 测试 + 构建自检，完成后可选用启动
#   bash 一键安装.sh --agent        # 非交互（交给 AI Agent / CI），不启动游戏
#   bash 一键安装.sh --install-node # 缺少 Node.js 时自动安装（macOS 需管理员密码）
#
# macOS 用户也可以直接双击「一键安装.command」。
set -u

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR" || exit 1

AGENT_MODE=0
INSTALL_NODE=0
for arg in "$@"; do
  case "$arg" in
    --agent|--yes|-y) AGENT_MODE=1 ;;
    --install-node) INSTALL_NODE=1 ;;
  esac
done

# shellcheck source=scripts/launcher-common.sh
. "$DIR/scripts/launcher-common.sh"

echo "===================================================="
echo "  本地人机德州扑克 - 一键配置（macOS / Linux）"
echo "  检查环境 + 安装依赖 + 测试 + 构建自检"
echo "===================================================="
echo

NODE_MODE=ask
if [ "$INSTALL_NODE" -eq 1 ]; then
  NODE_MODE=auto
elif [ "$AGENT_MODE" -eq 1 ]; then
  NODE_MODE=never
fi

if ! holdem_ensure_node "$NODE_MODE"; then
  if [ "$AGENT_MODE" -eq 0 ]; then
    read -r -p "按回车键退出..." _ || true
  fi
  exit 1
fi

node scripts/setup.mjs "$@"
SETUP_CODE=$?
if [ "$SETUP_CODE" -ne 0 ]; then
  echo
  echo "[错误] 配置失败（退出码 $SETUP_CODE），请根据上方提示排查后重试。"
  if [ "$AGENT_MODE" -eq 0 ]; then
    read -r -p "按回车键退出..." _ || true
  fi
  exit "$SETUP_CODE"
fi

# 非交互模式（--agent / --yes / -y）直接成功退出
if [ "$AGENT_MODE" -eq 1 ]; then
  exit 0
fi

echo
read -r -p "配置完成，现在就启动游戏吗？[Y/n] " answer || answer="n"
# 兼容 Windows 管道 / 远程终端可能带进来的 CR
answer="${answer%$'\r'}"
case "$answer" in
  n|N|no|NO|No)
    echo
    echo "已跳过启动。以后双击「启动德州扑克.command」，或运行 bash 启动德州扑克.sh 即可开始游戏。"
    echo
    ;;
  *)
    echo
    exec bash "$DIR/启动德州扑克.sh"
    ;;
esac
