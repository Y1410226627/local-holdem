@echo off
chcp 65001 >nul
setlocal EnableExtensions
title 本地人机德州扑克 - 一键配置
cd /d "%~dp0"

echo ====================================================
echo   本地人机德州扑克 - 一键配置
echo   检查环境 + 安装依赖 + 测试 + 构建自检
echo ====================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 Node.js。
  echo        请先安装 Node.js 22.12 或更高版本（推荐 24 LTS）：
  echo        https://nodejs.org/zh-cn/download
  echo.
  pause
  exit /b 1
)

set "AGENT_MODE="
for %%A in (%*) do (
  if /i "%%~A"=="--agent" set "AGENT_MODE=1"
  if /i "%%~A"=="--yes" set "AGENT_MODE=1"
  if /i "%%~A"=="-y" set "AGENT_MODE=1"
)

node scripts\setup.mjs %*
set "SETUP_CODE=%ERRORLEVEL%"
if not "%SETUP_CODE%"=="0" (
  echo.
  echo [错误] 配置失败（退出码 %SETUP_CODE%），请根据上方提示排查后重试。
  if not defined AGENT_MODE pause
  exit /b %SETUP_CODE%
)

if defined AGENT_MODE exit /b 0

echo.
choice /c YN /n /m "配置完成，现在就启动游戏吗？[Y/N] "
if errorlevel 2 (
  echo.
  echo 已跳过启动。以后双击「启动德州扑克.bat」即可开始游戏。
  echo.
  pause
  exit /b 0
)

echo.
call "%~dp0启动德州扑克.bat"
exit /b 0
