@echo off
chcp 65001 >nul <nul
setlocal EnableDelayedExpansion
title 本地德州扑克 - 训练机器人
cd /d "%~dp0"

set "AUTO=0"
set "ROUNDS="

rem ---- 解析无人值守参数：--yes / --rounds=N（顺序任意）----
rem 注意：cmd 会把 --rounds=100 拆成 --rounds 和 100 两个参数，因此两种写法都要兼容。
:parse_args
if "%~1"=="" goto args_done
set "ARG=%~1"
if /i "!ARG!"=="--yes" (
  set "AUTO=1"
  shift
  goto parse_args
)
if /i "!ARG!"=="--rounds" goto read_rounds
if /i "!ARG:~0,9!"=="--rounds=" (
  set "ROUNDS=!ARG:~9!"
  shift
  goto parse_args
)
echo [提示] 忽略未知参数：!ARG!
shift
goto parse_args

:read_rounds
shift
if "%~1"=="" (
  echo [错误] --rounds 后缺少轮数（应为正整数）。
  exit /b 1
)
set "ROUNDS=%~1"
shift
goto parse_args

:args_done

echo ====================================================
echo   本地德州扑克 - 自博弈训练
echo   规则引擎机器人（四档参数）+ 大模型机器人（few-shot + SFT）
echo ====================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 Node.js。请先安装 Node.js 22.12+（推荐 24 LTS）并加入 PATH：
  echo        https://nodejs.org/zh-cn/download
  echo.
  if not "!AUTO!"=="1" pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 npm。请检查 Node.js 安装是否完整。
  echo.
  if not "!AUTO!"=="1" pause
  exit /b 1
)

rem 检查 Node.js 版本等运行环境（不安装依赖）
node scripts\setup.mjs --check >nul 2>nul
if errorlevel 1 (
  echo [错误] 运行环境不满足要求（需要 Node.js 22.12+，推荐 24 LTS）。
  echo        请先双击「一键安装.bat」按提示配置，或升级 Node.js 后重试。
  echo.
  if not "!AUTO!"=="1" pause
  exit /b 1
)

if not exist "node_modules" (
  echo [1/2] 首次运行，正在安装依赖：npm install ...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo [错误] 依赖安装失败。请检查网络或手动运行 npm install 后重试。
    echo.
    if not "!AUTO!"=="1" pause
    exit /b 1
  )
) else (
  echo [1/2] 已检测到 node_modules，跳过依赖安装。
)

if not "!AUTO!"=="1" goto interactive_rounds

rem ---- 无人值守模式：--rounds 不传时默认 2 ----
if not defined ROUNDS set "ROUNDS=2"
call :validate_rounds
if errorlevel 1 (
  echo [错误] --rounds 必须是 1-10000 的正整数，收到：!ROUNDS!
  echo.
  exit /b 1
)
echo [自动模式] 跳过交互，训练轮数 = !ROUNDS!
goto rounds_ready

rem ---- 交互模式：1-10000，默认 2；非法输入重新询问 ----
:interactive_rounds
:ask_rounds
set "ROUNDS="
set /p "ROUNDS=请输入训练轮数（1-10000，回车默认 2）："
if not defined ROUNDS set "ROUNDS=2"
call :validate_rounds
if errorlevel 1 (
  echo [提示] 请输入 1-10000 的正整数，例如 1、10、100、1000。
  echo.
  goto ask_rounds
)

:rounds_ready
rem 16 核实测约 0.18 秒/轮（并行），加约 2 秒 worker 启动开销。
set /a "EST_SECONDS=2 + (%ROUNDS% * 18 + 99) / 100"
set /a "EST_MINUTES=EST_SECONDS/60"
echo.
echo   训练轮数：%ROUNDS% 轮（默认 60 手/轮、4 人桌）
if %EST_SECONDS% GEQ 60 (
  echo   预计约 %EST_SECONDS% 秒（约 %EST_MINUTES% 分钟；16 核并行估算，实际取决于机器性能）
) else (
  echo   预计约 %EST_SECONDS% 秒（实际取决于机器性能）
)
echo   注：轮数 ≥ 2 时会自动启用多核 worker 并行评估。

rem ---- 报告已精简：大小基本不随轮数增长；SFT/经验库按当前大小覆盖 ----
set "REPORT_KB=14"
set "SFT_KB=130"
set "EXP_KB=60"
set "PROFILE_KB=3"
if exist "training\llm-sft-dataset.jsonl" (
  for %%F in ("training\llm-sft-dataset.jsonl") do set /a "SFT_KB=(%%~zF+1023)/1024"
)
if exist "src\ai\data\llm-experience.json" (
  for %%F in ("src\ai\data\llm-experience.json") do set /a "EXP_KB=(%%~zF+1023)/1024"
)
if exist "src\ai\data\learnedProfiles.json" (
  for %%F in ("src\ai\data\learnedProfiles.json") do set /a "PROFILE_KB=(%%~zF+1023)/1024"
)
set /a "EXISTING_TOTAL_KB=0"
for %%F in ("src\ai\data\learnedProfiles.json" "src\ai\data\llm-experience.json" "training\REPORT.md" "training\llm-sft-dataset.jsonl") do (
  if exist "%%~fF" set /a "EXISTING_TOTAL_KB+=(%%~zF+1023)/1024"
)
set /a "EST_TOTAL_KB=REPORT_KB + SFT_KB + EXP_KB + PROFILE_KB"
set /a "NET_KB=EST_TOTAL_KB - EXISTING_TOTAL_KB"
if %NET_KB% LSS 0 set "NET_KB=0"
set /a "EST_TOTAL_MB=EST_TOTAL_KB/1024"
echo.
echo   预计文件大小增量（以当前文件为基线）：
if %EST_TOTAL_KB% GEQ 1024 (
  echo     - 写盘总量约 %EST_TOTAL_KB% KB（约 %EST_TOTAL_MB% MB；报告约 %REPORT_KB% KB，其余为覆盖更新）
) else (
  echo     - 写盘总量约 %EST_TOTAL_KB% KB（报告约 %REPORT_KB% KB，其余为覆盖更新）
)
if %NET_KB% LEQ 0 (
  echo     - 磁盘净增约 0 KB（报告已精简；产物为覆盖更新，文件通常不会变大）
) else (
  echo     - 磁盘净增约 %NET_KB% KB（主要是 SFT 数据集与经验库，报告已精简）
)
echo     - 报告不再逐轮展开，轮数再多也不会线性膨胀
echo.

if "!AUTO!"=="1" goto start_training

set "CONFIRM="
set /p "CONFIRM=确认开始训练？(Y/N)："
if /i not "!CONFIRM!"=="Y" (
  echo.
  echo 已取消训练，未写入任何文件。
  echo.
  pause
  exit /b 0
)

:start_training
echo.
echo [2/2] 开始训练（自博弈 + 四档参数进化 + 大模型训练数据）...
echo.
call npm run train -- --rounds=%ROUNDS%
if errorlevel 1 (
  echo.
  echo [错误] 训练失败，请查看上方日志。
  echo.
  if not "!AUTO!"=="1" pause
  exit /b 1
)

echo.
echo ====================================================
echo   训练完成！
echo ====================================================
echo   训练报告：    training\REPORT.md
echo   SFT 数据集：  training\llm-sft-dataset.jsonl
echo   few-shot 库： src\ai\data\llm-experience.json
echo   训练参数：    src\ai\data\learnedProfiles.json
echo.
echo   如何启用训练参数：
echo     - 在应用设置中打开「使用训练后参数」开关（默认关闭）
echo     - 开关对应 localStorage: holdem-learned-profiles-v1
echo     - 或调用 setLearnedProfilesEnabled(true)
echo     - 训练参数默认不启用，不影响普通对局
echo     - 刷新页面 / npm run build 后生效
echo.
echo   llm-sft-dataset.jsonl 可交给本地微调工具（llama.cpp / LlamaFactory 等）
echo   做可选微调；本项目不自动微调，应用内大模型机器人仍用 few-shot 经验库。
echo ====================================================
echo.
if not "%AUTO%"=="1" pause
exit /b 0

:validate_rounds
rem 1-10000：本机 16 核实测约 0.18 秒/轮，1 万轮约 30 分钟；更大规模请分多次训练。
echo(!ROUNDS!| findstr /r /x "[1-9][0-9]*" >nul
if errorlevel 1 exit /b 1
set /a "ROUNDS_NUM=ROUNDS" 2>nul
if errorlevel 1 exit /b 1
if !ROUNDS_NUM! LSS 1 exit /b 1
if !ROUNDS_NUM! GTR 10000 exit /b 1
exit /b 0
