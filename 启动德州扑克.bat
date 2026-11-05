@echo off
chcp 65001 >nul
setlocal
title 本地人机德州扑克 - 启动器
cd /d "%~dp0"

echo ============================================
echo    本地人机德州扑克  一键启动
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 Node.js，请先安装 Node.js 22.12 或更高版本（推荐 24 LTS）：
  echo        https://nodejs.org/zh-cn/download
  echo.
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 npm，请重新安装 Node.js。
  pause
  exit /b 1
)

rem 检查 Node.js 版本等运行环境（不安装依赖）
node scripts\setup.mjs --check
if errorlevel 1 (
  echo.
  echo [错误] 运行环境不满足要求。请先双击「一键安装.bat」按提示配置，
  echo        或安装 Node.js 22.12 或更高版本（推荐 24 LTS）。
  echo.
  pause
  exit /b 1
)
echo.

rem 如果本地服务已经在运行，直接打开浏览器
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $null = Invoke-WebRequest -UseBasicParsing -Uri 'http://localhost:5173/' -TimeoutSec 2; exit 0 } catch { exit 1 }"
if not errorlevel 1 (
  echo [提示] 检测到本地服务已经在运行：http://localhost:5173
  if /i "%~1"=="--no-open" (
    echo        未打开浏览器（--no-open）。
  ) else (
    echo        正在打开浏览器...
    start "" "http://localhost:5173"
  )
  exit /b 0
)

if not exist "node_modules" (
  echo [1/2] 首次运行，正在安装依赖（需要联网，约 1-2 分钟）...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo [错误] 依赖安装失败，请检查网络后重新运行本文件。
    pause
    exit /b 1
  )
  echo 依赖安装完成。
  echo.
)

echo [2/2] 正在启动本地服务，浏览器将自动打开...
echo        地址：http://localhost:5173
echo        关闭本窗口或按 Ctrl+C 可停止服务。
echo.
if /i "%~1"=="--no-open" (
  call npm run dev
) else (
  call npm run dev -- --open
)

echo.
echo 服务已停止。
pause
endlocal