#!/usr/bin/env bash
# 本地人机德州扑克 · 一键同步数据（macOS / Linux 终端版）
#
# 把旧版本文件夹里的训练参数 / 经验库 / 训练产物同步到当前版本（覆盖前自动备份）。
# 浏览器里的设置与大模型对局记忆无需同步（同浏览器 + 同端口自动沿用）。
#
# 用法：
#   bash 一键同步数据.sh                    # 自动在上级目录找旧版本并交互选择
#   bash 一键同步数据.sh --from=../旧版本   # 指定旧版本目录
#   bash 一键同步数据.sh --dry-run          # 只看计划，不写文件
#   bash 一键同步数据.sh --list             # 只列出找到的旧版本
#   bash 一键同步数据.sh --agent            # 无人值守（不交互）
#
# macOS 用户也可以直接双击「一键同步数据.command」。
set -u

DIR="$(cd "$(dirname "$BASH_SOURCE")" && pwd)"
cd "$DIR" || exit 1

NO_PAUSE=0
for arg in "$@"; do
  case "$arg" in
    --agent|--yes|-y|--no-pause) NO_PAUSE=1 ;;
  esac
done

echo "============================================"
echo "   本地人机德州扑克  一键同步数据"
echo "============================================"
echo

if ! command -v node >/dev/null 2>&1; then
  echo "[错误] 未检测到 Node.js。"
  echo "       请先双击「一键安装.command」（或运行 bash 一键安装.sh）完成配置。"
  echo
  if [ "$NO_PAUSE" -eq 0 ]; then
    read -r -p "按回车键退出..." _ || true
  fi
  exit 1
fi

node scripts/sync-data.mjs "$@"
status=$?

echo
if [ "$status" -ne 0 ]; then
  echo "[结果] 同步未完成（退出码 $status）。"
else
  echo "[结果] 同步流程结束；建议重新运行「启动德州扑克」让新数据生效。"
fi

if [ "$NO_PAUSE" -eq 0 ]; then
  echo
  read -r -p "按回车键退出..." _ || true
fi

exit "$status"
