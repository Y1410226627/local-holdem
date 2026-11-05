#!/usr/bin/env node
/**
 * 本地人机德州扑克 · 一键配置脚本（跨平台：Windows / macOS / Linux）
 *
 * 作用：检查运行环境 → 安装依赖 → 跑全部测试 → 类型检查 + 生产构建自检。
 * 不启动开发服务器（启动方式见运行结束后的提示），不写入任何配置到系统。
 *
 * 用法：
 *   node scripts/setup.mjs                  # 完整配置：安装 + 测试 + 构建
 *   node scripts/setup.mjs --agent          # 非交互（适合交给 AI Agent / CI），最后输出 SETUP_RESULT=OK
 *   node scripts/setup.mjs --skip-tests     # 安装 + 构建，跳过测试
 *   node scripts/setup.mjs --install-only   # 只安装依赖
 *   node scripts/setup.mjs --check          # 只检查环境（供 .bat 启动器调用），不安装
 *   node scripts/setup.mjs --help           # 查看帮助
 *
 * 退出码：0 = 成功；1 = 失败（原因见输出）。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ARGS = process.argv.slice(2);
const NODE_REQUIRED = '22.12+（推荐 24 LTS）';
const IS_WINDOWS = process.platform === 'win32';

const hasFlag = (...names) => names.some((name) => ARGS.includes(name));
const CHECK_ONLY = hasFlag('--check');
const AGENT_MODE = hasFlag('--agent', '--yes', '-y') || process.env.CI === 'true';
const HELP = hasFlag('--help', '-h');
const SKIP_TESTS = hasFlag('--skip-tests');
const INSTALL_ONLY = hasFlag('--install-only');

function print(message = '') {
  console.log(message);
}

function fail(message) {
  print('');
  print(`[失败] ${message}`);
  print('');
  print('SETUP_RESULT=FAIL');
  process.exit(1);
}

/** 项目支持的 Node.js 版本：22.12+ / 24.x / 26+（与 Vite 8、Vitest 5 的 engines 保持一致）。 */
function isSupportedNode(version = process.versions.node) {
  const [major, minor] = version.split('.').map((part) => Number(part));
  if (!Number.isInteger(major) || !Number.isInteger(minor)) return false;
  if (major === 22) return minor >= 12;
  return major === 24 || major >= 26;
}

function detectNpm() {
  // 通过 shell 执行单条命令字符串（Windows 上 npm 是 .cmd，需要 shell；避免 Node 的 args+shell 弃用警告）。
  const result = spawnSync('npm --version', {
    cwd: ROOT,
    encoding: 'utf8',
    shell: true,
    timeout: 60_000,
  });
  if (result.error || result.status !== 0) return null;
  return (result.stdout || '').trim();
}

function runNpm(commandLine, label) {
  print(`[执行] npm ${commandLine}`);
  const started = Date.now();
  const result = spawnSync(`npm ${commandLine}`, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: true,
    env: process.env,
  });
  if (result.error) {
    fail(`${label}无法执行：${result.error.message}`);
  }
  if (result.status !== 0) {
    if (commandLine.startsWith('install')) {
      print('');
      print('依赖安装失败。请检查网络后重试；国内网络可以先执行：');
      print('  npm config set registry https://registry.npmmirror.com');
      print('然后重新运行「一键安装.bat」或 node scripts/setup.mjs。');
    }
    fail(`${label}失败（npm 退出码 ${result.status}）。`);
  }
  return ((Date.now() - started) / 1000).toFixed(1);
}

function printHelp() {
  print('本地人机德州扑克 · 一键配置脚本');
  print('');
  print('用法：node scripts/setup.mjs [选项]');
  print('');
  print('选项：');
  print('  --agent         非交互模式（不提问；结束时输出 SETUP_RESULT=OK/FAIL）');
  print('  --skip-tests    安装依赖 + 构建，跳过测试');
  print('  --install-only  只安装依赖（跳过测试与构建）');
  print('  --check         只检查环境（供「启动德州扑克.bat」调用），不安装');
  print('  --help, -h      显示本帮助');
  print('');
  print('示例：');
  print('  node scripts/setup.mjs --agent     # 交给 AI Agent 或 CI 执行');
  print('  node scripts/setup.mjs --skip-tests');
}

function checkEnvironment() {
  const packageJsonPath = join(ROOT, 'package.json');
  if (!existsSync(packageJsonPath)) {
    fail(`没有找到 ${packageJsonPath}，请在项目根目录运行本脚本。`);
  }
  let packageJson;
  try {
    packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  } catch (error) {
    fail(`package.json 解析失败：${error.message}`);
  }
  if (packageJson.name !== 'local-holdem') {
    fail(`package.json 名称异常（${packageJson.name}），可能不在本项目目录。`);
  }

  const nodeOk = isSupportedNode();
  const npmVersion = detectNpm();

  if (CHECK_ONLY) {
    print(`[check] Node.js ${process.versions.node}  ${nodeOk ? 'OK' : `不支持（需要 ${NODE_REQUIRED}）`}`);
    print(`[check] npm       ${npmVersion ?? '未找到（请重新安装 Node.js）'}`);
    print(
      `[check] 依赖      ${existsSync(join(ROOT, 'node_modules')) ? '已安装（node_modules）' : '未安装（首次启动会自动安装）'}`,
    );
    if (!nodeOk || !npmVersion) process.exit(1);
    print('CHECK_RESULT=OK');
    process.exit(0);
  }

  print(`[ 1/${INSTALL_ONLY ? 2 : SKIP_TESTS ? 3 : 4} ] 检查运行环境...`);
  print(`  Node.js：v${process.versions.node}（要求 ${NODE_REQUIRED}）`);
  print(`  npm    ：${npmVersion ?? '未找到'}`);

  if (!nodeOk) {
    print('');
    print(`[失败] 当前 Node.js 版本 v${process.versions.node} 不受支持。`);
    print('       本项目需要 Node.js 22.12 或更高版本（推荐 24 LTS）。');
    print('       请到 https://nodejs.org/zh-cn/download 安装后重新运行（macOS 也可 brew install node）。');
    print('');
    print('SETUP_RESULT=FAIL');
    process.exit(1);
  }
  if (!npmVersion) {
    print('');
    print('[失败] 找不到 npm。请重新安装 Node.js（安装包自带 npm）后重试。');
    print('');
    print('SETUP_RESULT=FAIL');
    process.exit(1);
  }
  print('[ 环境 ] OK');
}

function printSummary() {
  print('');
  print('====================================================');
  print('  配置完成，可以开始游戏了');
  print('====================================================');
  print('');
  print('启动游戏：');
  if (IS_WINDOWS) {
    print('  Windows：双击项目根目录的「启动德州扑克.bat」');
  } else if (process.platform === 'darwin') {
    print('  macOS  ：双击「启动德州扑克.command」，或运行 bash 启动德州扑克.sh');
  } else {
    print('  Linux  ：运行 bash 启动德州扑克.sh');
  }
  print('  命令行  ：npm run dev -- --open（浏览器打开 http://localhost:5173）');
  print('');
  print('训练机器人：');
  if (IS_WINDOWS) {
    print('  Windows：双击「训练机器人.bat」（先问轮数、估时，确认后开始）');
  } else {
    print('  macOS / Linux：npm run train（命令行；交互式训练器目前仅 Windows .bat）');
  }
  print('  命令行  ：npm run train:quick（约 2 秒）或 npm run train');
  print('');
  print('可选：接入本地大模型机器人');
  print('  游戏内「大模型设置」填写你本机运行的 Ollama / LM Studio 等 OpenAI 兼容地址；不填也能正常游玩。');
  print('');
  print('更多说明：README.md（快速开始 / 规则 / AI / 训练 / 已知限制）');
  print('给 AI Agent 的安装说明：AGENTS.md');
  print('');
  print('SETUP_RESULT=OK');
}

function main() {
  if (HELP) {
    printHelp();
    return;
  }

  print('');
  print('====================================================');
  print('  本地人机德州扑克 · 一键配置');
  print('  规则引擎 + 本地算法 AI + 可选本地大模型');
  print('====================================================');

  checkEnvironment();

  print(`[ 2/${INSTALL_ONLY ? 2 : SKIP_TESTS ? 3 : 4} ] 安装依赖（首次需要联网，约 10–60 秒）...`);
  const installSeconds = runNpm('install --no-audit --no-fund', '依赖安装');
  if (!existsSync(join(ROOT, 'node_modules'))) {
    fail('npm 安装结束但找不到 node_modules，请检查 npm 权限后重试。');
  }
  print(`[ 依赖 ] OK（${installSeconds}s）`);

  if (!INSTALL_ONLY) {
    if (!SKIP_TESTS) {
      print('');
      print('[ 3/4 ] 运行全部测试（共 21 个测试文件 / 266 个用例）...');
      const testSeconds = runNpm('test', '测试');
      print(`[ 测试 ] OK（${testSeconds}s）`);
    }

    print('');
    print(`[ ${SKIP_TESTS ? 3 : 4}/${SKIP_TESTS ? 3 : 4} ] TypeScript 类型检查 + 生产构建...`);
    const buildSeconds = runNpm('run build', '构建');
    print(`[ 构建 ] OK（${buildSeconds}s，产物 dist/）`);
  }

  printSummary();
}

main();
