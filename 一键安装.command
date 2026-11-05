#!/usr/bin/env bash
# macOS 双击入口：在「终端」里运行「一键安装.sh」。
# 首次从 GitHub 下载 zip 后若提示“无法验证开发者”：右键 → 打开，或执行 xattr -dr com.apple.quarantine .
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$DIR/一键安装.sh" "$@"
