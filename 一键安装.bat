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

rem ---- 解析参数：--agent 无人值守 / --install-node 允许自动安装 Node.js ----
set "AGENT_MODE="
set "INSTALL_NODE="
for %%A in (%*) do (
  if /i "%%~A"=="--agent" set "AGENT_MODE=1"
  if /i "%%~A"=="--yes" set "AGENT_MODE=1"
  if /i "%%~A"=="-y" set "AGENT_MODE=1"
  if /i "%%~A"=="--install-node" set "INSTALL_NODE=1"
)

rem ---- 检查 Node.js；未安装时按模式自动安装 ----
where node >nul 2>nul
if not errorlevel 1 goto node_ready

set "NODE_MODE=Ask"
if defined AGENT_MODE set "NODE_MODE=Never"
if defined INSTALL_NODE set "NODE_MODE=Auto"

if "%NODE_MODE%"=="Auto" goto node_install_auto
if "%NODE_MODE%"=="Ask" goto node_install_ask
echo [提示] 未检测到 Node.js（--agent 无人值守模式不会自动安装，可加 --install-node）。
goto node_after_install

:node_install_auto
echo [安装] 正在自动安装 Node.js 官方 LTS...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-node.ps1" -Mode Auto
goto node_after_install

:node_install_ask
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-node.ps1" -Mode Ask
goto node_after_install

:node_after_install
rem 刚安装完时当前窗口 PATH 可能还没刷新，补上官方 MSI 的默认安装目录
if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
where node >nul 2>nul
if not errorlevel 1 goto node_ready
echo.
echo [错误] 未检测到可用的 Node.js，无法继续。
echo        请手动安装 Node.js 22.12 或更高版本（推荐 24 LTS）：
echo        https://nodejs.org/zh-cn/download
echo        安装完成后重新双击「一键安装.bat」即可。
echo.
if not defined AGENT_MODE pause
exit /b 1

:node_ready
rem ---- 运行一键配置（安装依赖 + 测试 + 构建自检） ----
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
