@echo off
chcp 65001 >nul
setlocal EnableExtensions
title 本地人机德州扑克 - 打包安卓 APK
cd /d "%~dp0"

echo ====================================================
echo   本地人机德州扑克 - 打包安卓 APK
echo   构建 Web - 同步安卓工程 - Gradle 打包 - 输出 apk
echo ====================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未检测到 Node.js，请先双击「一键安装.bat」。
  echo.
  pause
  exit /b 1
)

rem ---- 构建参数：--debug 打调试包；--skip-web 复用已有 dist ----
node scripts\build-apk.mjs %*
set "APK_CODE=%ERRORLEVEL%"

echo.
if not "%APK_CODE%"=="0" (
  echo [失败] 打包失败（退出码 %APK_CODE%），请根据上方提示排查。
  echo        常见原因：未安装 JDK 21 / Android SDK，或项目路径含中文（脚本会自动复制到 ASCII 目录）。
  echo.
  pause
  exit /b %APK_CODE%
)

echo [完成] APK 已生成在 apk 目录，传到手机点击安装即可。
echo        以后每次版本更新，重新双击本文件即可覆盖安装（同一签名）。
echo.
pause
exit /b 0
