#!/usr/bin/env bash
# 启动器共享逻辑（macOS / Linux）：确保 Node.js 可用。
# 由 一键安装.sh、启动德州扑克.sh 通过 source 引用，不单独运行。

holdem_os() {
  case "$(uname -s 2>/dev/null)" in
    Darwin*) echo mac ;;
    Linux*) echo linux ;;
    *) echo other ;;
  esac
}

holdem_open_url() {
  if command -v open >/dev/null 2>&1; then
    open "$1" >/dev/null 2>&1 || true
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$1" >/dev/null 2>&1 || true
  fi
}

# 从 nodejs.org/dist/index.json 的内容里提取最新 LTS 版本号（如 v24.11.1）。
# 输入：stdin 的 JSON 文本；匹配形如 "lts":"Krypton" 的条目（非 LTS 条目是 "lts":false）。
holdem_parse_latest_lts() {
  grep -o '"version":"v[0-9][^"]*"[^}]*"lts":"[^"]*"' \
    | head -n 1 \
    | sed -n 's/.*"version":"\(v[0-9][^"]*\)".*/\1/p'
}

# macOS：下载 nodejs.org 官方 LTS 安装包并安装（需要管理员密码）。成功返回 0。
holdem_install_node_mac() {
  local json version pkg
  if command -v curl >/dev/null 2>&1 && command -v installer >/dev/null 2>&1; then
    echo "       正在查询 Node.js 官方 LTS 版本..."
    json="$(curl -fsSL --max-time 30 https://nodejs.org/dist/index.json 2>/dev/null)" || json=""
    version="$(printf '%s' "$json" | holdem_parse_latest_lts)"
    if [ -n "$version" ]; then
      pkg="/tmp/holdem-node-$version.pkg"
      echo "       即将下载 Node.js $version 官方安装包（约 50-80 MB），安装时需要输入 Mac 登录密码。"
      if curl -fL --max-time 600 -o "$pkg" "https://nodejs.org/dist/$version/node-$version.pkg"; then
        if sudo installer -pkg "$pkg" -target /; then
          rm -f "$pkg"
          hash -r
          command -v node >/dev/null 2>&1
          return $?
        fi
        rm -f "$pkg"
        echo "       [警告] 官方安装包安装未成功（可能取消了密码输入或没有管理员权限）。"
      fi
    fi
  fi
  # 官方安装包失败时的备选：Homebrew（如果已安装）。
  if command -v brew >/dev/null 2>&1; then
    echo "       尝试用 Homebrew 安装：brew install node"
    if brew install node; then
      hash -r
      command -v node >/dev/null 2>&1
      return $?
    fi
  fi
  return 1
}

holdem_print_node_help() {
  local os="$1"
  echo
  echo "       请安装 Node.js 22.12+（推荐 24 LTS）："
  echo "       https://nodejs.org/zh-cn/download"
  if [ "$os" = "mac" ]; then
    echo "       macOS 也可以在终端运行：brew install node"
  else
    echo "       Linux 可以用 nvm 或发行版包管理器安装（版本需要 22.12+）。"
  fi
  echo
}

# 确保 Node.js 可用。
# 用法：holdem_ensure_node ask|auto|never
#   ask   : 未安装时询问是否自动安装（交互式默认）
#   auto  : 未安装时直接自动安装（对应 --install-node；macOS 需管理员密码）
#   never : 不安装，只给出手动安装指引（--agent 等无人值守场景默认，避免意外改系统）
holdem_ensure_node() {
  local mode="${1:-ask}"
  if command -v node >/dev/null 2>&1; then
    return 0
  fi
  echo "[提示] 未检测到 Node.js（本项目需要 Node.js 22.12+，推荐 24 LTS）。"
  local os try_install answer
  os="$(holdem_os)"
  try_install=0

  case "$mode" in
    auto)
      try_install=1
      ;;
    ask)
      if [ "$os" = "mac" ]; then
        read -r -p "       是否现在自动安装 Node.js 官方 LTS 安装包？[Y/n] " answer || answer="n"
        answer="${answer%$'\r'}"
        case "$answer" in
          n|N|no|NO|No) : ;;
          *) try_install=1 ;;
        esac
      fi
      ;;
  esac

  if [ "$try_install" -eq 1 ]; then
    if [ "$os" = "mac" ]; then
      if holdem_install_node_mac; then
        echo "[安装] Node.js 安装完成：$(node -v)"
        return 0
      fi
      echo "       [警告] 自动安装未成功（可能需要管理员密码、Homebrew 或网络受限）。"
    else
      echo "       当前系统暂不支持自动安装 Node.js（Linux 发行版差异较大）。"
    fi
  fi

  holdem_print_node_help "$os"
  if [ "$mode" != "never" ]; then
    holdem_open_url "https://nodejs.org/zh-cn/download"
    echo "       （已尝试为你打开官网下载页；安装完成后重新双击本文件即可）"
  else
    echo "       无人值守模式下不会自动安装；也可以加 --install-node 让脚本自动安装。"
  fi
  return 1
}
