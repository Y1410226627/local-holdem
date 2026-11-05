@echo off
chcp 65001 >nul
setlocal EnableExtensions
title 本地人机德州扑克 - 一键同步数据
cd /d "%~dp0"

echo ============================================
echo    本地人机德州扑克  一键同步数据
echo    把旧版本里的训练参数 / 经验库 / 训练产物同步到当前版本
echo ============================================
echo.

set "NO_PAUSE="
for %%A in (%*) do (
  if /i "%%~A"=="--agent" set "NO_PAUSE=1"
  if /i "%%~A"=="--yes" set "NO_PAUSE=1"
  if /i "%%~A"=="-y" set "NO_PAUSE=1"
  if /i "%%~A"=="--no-pause" set "NO_PAUSE=1"
)

rem ---- 检查 Node.js（同步脚本只依赖 Node，不依赖 node_modules） ----
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未检测到 Node.js。
  echo        请先双击「一键安装.bat」完成配置，或安装 Node.js 22.12 或更高版本（推荐 24 LTS）。
  echo.
  if not defined NO_PAUSE pause
  exit /b 1
)

node scripts\sync-data.mjs %*
set "SYNC_EXIT=%ERRORLEVEL%"

echo.
if not "%SYNC_EXIT%"=="0" (
  echo [结果] 同步未完成（退出码 %SYNC_EXIT%）。
) else (
  echo [结果] 同步流程结束；建议重新双击「启动德州扑克」让新数据生效。
)

if not defined NO_PAUSE (
  echo.
  pause
)
endlocal
exit /b %SYNC_EXIT%
