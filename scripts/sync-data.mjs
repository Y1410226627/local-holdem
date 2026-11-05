#!/usr/bin/env node
/**
 * 一键同步数据：把旧版本文件夹里的本地数据同步到当前版本。
 *
 * 同步内容（存在才同步）：
 *   src/ai/data/learnedProfiles.json   （训练参数）
 *   src/ai/data/llm-experience.json    （大模型 few-shot 经验）
 *   training/REPORT.md                 （训练报告）
 *   training/llm-sft-dataset.jsonl     （SFT 数据集）
 *
 * 覆盖当前版本同名文件前，会自动备份到：backup/sync-<时间戳>/。
 * 浏览器里的设置 / 大模型配置 / 大模型对局记忆保存在 localStorage，
 * 同一浏览器 + 同一端口会自动沿用，不需要本脚本同步。
 *
 * 用法：
 *   node scripts/sync-data.mjs                    # 自动在上级目录找旧版本并交互选择
 *   node scripts/sync-data.mjs --from=../旧版本   # 指定旧版本目录
 *   node scripts/sync-data.mjs --list             # 只列出找到的旧版本
 *   node scripts/sync-data.mjs --dry-run          # 预览计划，不写任何文件
 *   node scripts/sync-data.mjs --yes              # 不询问，自动选数据最新的旧版本
 *   node scripts/sync-data.mjs --agent            # 无人值守（同 --yes，不交互）
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const PROJECT_NAME = 'local-holdem';
export const BACKUP_DIR = 'backup';
export const SYNC_FILES = [
  'src/ai/data/learnedProfiles.json',
  'src/ai/data/llm-experience.json',
  'training/REPORT.md',
  'training/llm-sft-dataset.jsonl',
];

const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', 'backup', '.git', '.vite', '.idea', '.vscode', '__pycache__']);

function statSafe(target) {
  try {
    return fs.statSync(target);
  } catch {
    return null;
  }
}

function dirSafe(target) {
  const stat = statSafe(target);
  return stat && stat.isDirectory() ? stat : null;
}

function readJsonSafe(target) {
  try {
    return JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch {
    return null;
  }
}

/** 该目录是否是一个 local-holdem 项目根目录（按 package.json 的 name 判断）。 */
export function isProjectRoot(dir) {
  const pkg = readJsonSafe(path.join(dir, 'package.json'));
  return Boolean(pkg && typeof pkg === 'object' && pkg.name === PROJECT_NAME);
}

/** 列出目录里存在的数据文件（相对路径 + 大小 + 修改时间）。 */
export function collectDataFiles(projectRoot) {
  const files = [];
  for (const relPath of SYNC_FILES) {
    const absPath = path.join(projectRoot, relPath);
    const stat = statSafe(absPath);
    if (!stat || !stat.isFile()) continue;
    files.push({ relPath, absPath, size: stat.size, mtimeMs: stat.mtimeMs });
  }
  return files;
}

/**
 * 在 searchRoot 下按广度优先（默认最多 2 层）扫描其他 local-holdem 项目目录。
 * 返回按「数据最新」排序的候选列表。
 */
export function findSyncCandidates(searchRoot, options = {}) {
  const {
    excludeDir = ROOT,
    maxDepth = 2,
    maxEntries = 600,
  } = options;
  const excluded = path.resolve(excludeDir);
  const candidates = [];
  const queue = [{ dir: path.resolve(searchRoot), depth: 0 }];
  let seen = 0;
  while (queue.length > 0 && seen < maxEntries) {
    const current = queue.shift();
    seen += 1;
    let entries;
    try {
      entries = fs.readdirSync(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
      const child = path.join(current.dir, entry.name);
      if (path.resolve(child) === excluded) continue;
      if (isProjectRoot(child)) {
        const files = collectDataFiles(child);
        const latestMtimeMs = files.reduce((max, file) => Math.max(max, file.mtimeMs), 0);
        const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
        candidates.push({ dir: child, files, latestMtimeMs, totalBytes });
        continue;
      }
      if (current.depth + 1 < maxDepth) {
        queue.push({ dir: child, depth: current.depth + 1 });
      }
    }
  }
  candidates.sort((a, b) => b.latestMtimeMs - a.latestMtimeMs || b.totalBytes - a.totalBytes);
  return candidates;
}

/** 候选里数据最新的一个（没有候选时返回 null）。 */
export function pickBestCandidate(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  return candidates.slice().sort((a, b) => b.latestMtimeMs - a.latestMtimeMs || b.totalBytes - a.totalBytes)[0];
}

function timestampOf(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return (
    String(date.getFullYear()) +
    pad(date.getMonth() + 1) +
    pad(date.getDate()) +
    '-' +
    pad(date.getHours()) +
    pad(date.getMinutes()) +
    pad(date.getSeconds())
  );
}

function filesEqual(a, b) {
  try {
    const statA = fs.statSync(a);
    const statB = fs.statSync(b);
    if (statA.size !== statB.size) return false;
    return fs.readFileSync(a).equals(fs.readFileSync(b));
  } catch {
    return false;
  }
}

/**
 * 把 fromDir 的数据文件复制到 toDir。
 * - 目标已存在且内容不同：先备份到 backup/sync-<时间戳>/<相对路径>；
 * - 目标已存在且内容相同：跳过（identical）；
 * - 源文件不存在：计入 missing；
 * - dryRun：只计算，不写文件。
 */
export function copySyncData(options) {
  const { fromDir, toDir, dryRun = false, now = new Date(), backupDirName = null } = options;
  const sourceRoot = path.resolve(fromDir);
  const targetRoot = path.resolve(toDir);
  if (sourceRoot === targetRoot) throw new Error('源目录与当前目录相同，无需同步');
  if (!isProjectRoot(sourceRoot)) throw new Error('源目录不是 local-holdem 项目：' + sourceRoot);

  const backupDir = path.join(
    targetRoot,
    BACKUP_DIR,
    backupDirName ?? 'sync-' + timestampOf(now),
  );
  const result = {
    fromDir: sourceRoot,
    toDir: targetRoot,
    backupDir,
    dryRun,
    copied: [],
    backedUp: [],
    identical: [],
    missing: [],
  };

  for (const relPath of SYNC_FILES) {
    const sourceFile = path.join(sourceRoot, relPath);
    if (!statSafe(sourceFile)) {
      result.missing.push(relPath);
      continue;
    }
    const targetFile = path.join(targetRoot, relPath);
    const targetStat = statSafe(targetFile);
    if (targetStat && targetStat.isFile() && filesEqual(sourceFile, targetFile)) {
      result.identical.push(relPath);
      continue;
    }
    if (targetStat && targetStat.isFile()) {
      result.backedUp.push(relPath);
      if (!dryRun) {
        const backupTarget = path.join(backupDir, relPath);
        fs.mkdirSync(path.dirname(backupTarget), { recursive: true });
        fs.copyFileSync(targetFile, backupTarget);
      }
    }
    result.copied.push(relPath);
    if (!dryRun) {
      fs.mkdirSync(path.dirname(targetFile), { recursive: true });
      fs.copyFileSync(sourceFile, targetFile);
    }
  }
  return result;
}

/** 解析命令行参数。 */
export function parseArgs(argv) {
  const parsed = {
    from: null,
    scanDir: null,
    dryRun: false,
    list: false,
    yes: false,
    agent: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--from') {
      parsed.from = argv[index + 1] ?? null;
      index += 1;
    } else if (arg.startsWith('--from=')) {
      parsed.from = arg.slice('--from='.length) || null;
    } else if (arg === '--scan-dir') {
      parsed.scanDir = argv[index + 1] ?? null;
      index += 1;
    } else if (arg.startsWith('--scan-dir=')) {
      parsed.scanDir = arg.slice('--scan-dir='.length) || null;
    } else if (arg === '--dry-run') {
      parsed.dryRun = true;
    } else if (arg === '--list') {
      parsed.list = true;
    } else if (arg === '--yes' || arg === '-y') {
      parsed.yes = true;
    } else if (arg === '--agent') {
      parsed.agent = true;
      parsed.yes = true;
    } else if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    }
    // 其他参数忽略（.bat / .sh 可能透传启动参数）。
  }
  return parsed;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}

function formatTime(ms) {
  if (!ms) return '无数据';
  const date = new Date(ms);
  const pad = (value) => String(value).padStart(2, '0');
  return (
    date.getFullYear() +
    '-' +
    pad(date.getMonth() + 1) +
    '-' +
    pad(date.getDate()) +
    ' ' +
    pad(date.getHours()) +
    ':' +
    pad(date.getMinutes())
  );
}

function printUsage() {
  console.log('用法：node scripts/sync-data.mjs [选项]');
  console.log('');
  console.log('  --from <目录>     指定旧版本目录（含 package.json 的那一层）');
  console.log('  --scan-dir <目录> 指定自动搜索的上级目录（默认：当前项目的上一级）');
  console.log('  --list            只列出找到的旧版本目录，不做任何修改');
  console.log('  --dry-run         预览要同步的文件，不写任何文件');
  console.log('  --yes, -y         不询问，自动选择数据最新的旧版本');
  console.log('  --agent           无人值守模式（同 --yes，且不交互）');
  console.log('  --help, -h        显示帮助');
  console.log('');
  console.log('同步文件：');
  for (const relPath of SYNC_FILES) console.log('  - ' + relPath);
  console.log('');
  console.log('覆盖前会自动备份到 backup/sync-<时间戳>/；浏览器里的设置与大模型记忆无需同步。');
}

function printCurrentData() {
  const files = collectDataFiles(ROOT);
  console.log('当前版本的数据文件：');
  if (files.length === 0) {
    console.log('  （当前版本没有找到可同步的数据文件）');
    return;
  }
  for (const file of files) {
    console.log('  - ' + file.relPath + '  ' + formatBytes(file.size) + '  ' + formatTime(file.mtimeMs));
  }
}

function printCandidates(candidates) {
  console.log('找到 ' + candidates.length + ' 个旧版本目录：');
  candidates.forEach((candidate, index) => {
    const fileText = candidate.files.length === 0 ? '无数据文件' : candidate.files.length + ' 个数据文件 / ' + formatBytes(candidate.totalBytes);
    console.log('');
    console.log('  [' + (index + 1) + '] ' + candidate.dir);
    console.log('      最近更新：' + formatTime(candidate.latestMtimeMs) + '；' + fileText);
    for (const file of candidate.files) {
      console.log('        - ' + file.relPath + '  ' + formatBytes(file.size) + '  ' + formatTime(file.mtimeMs));
    }
  });
}

async function ask(question) {
  const rl = readline.createInterface({ input, output });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

function printResult(result) {
  const prefix = result.dryRun ? '[预览] ' : '';
  console.log('');
  console.log(prefix + '同步结果：');
  console.log('  旧版本：' + result.fromDir);
  console.log('  当前版本：' + result.toDir);
  console.log('  已复制（' + result.copied.length + '）：' + (result.copied.join('、') || '无'));
  console.log('  内容相同跳过（' + result.identical.length + '）：' + (result.identical.join('、') || '无'));
  console.log('  旧版本缺失（' + result.missing.length + '）：' + (result.missing.join('、') || '无'));
  console.log('  覆盖前备份（' + result.backedUp.length + '）：' + (result.backedUp.join('、') || '无'));
  if (result.backedUp.length > 0) {
    console.log('  备份位置：' + (result.dryRun ? result.backupDir + '（预览，未创建）' : result.backupDir));
  }
  if (result.dryRun) {
    console.log('');
    console.log('这是预览模式，没有写入任何文件。确认无误后去掉 --dry-run 再运行一次。');
    return;
  }
  if (result.copied.length > 0) {
    console.log('');
    console.log('完成。建议重新双击「启动德州扑克」让新数据生效（浏览器设置无需处理）。');
  } else {
    console.log('');
    console.log('没有需要复制的文件（数据已一致或旧版本没有数据文件）。');
  }
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    printUsage();
    return 0;
  }

  const searchRoot = args.scanDir ? path.resolve(args.scanDir) : path.dirname(ROOT);
  const candidates = findSyncCandidates(searchRoot);

  if (args.list) {
    console.log('搜索目录：' + searchRoot);
    if (candidates.length === 0) {
      console.log('没有找到其他 local-holdem 目录。');
    } else {
      printCandidates(candidates);
    }
    console.log('');
    printCurrentData();
    return 0;
  }

  console.log('============================================');
  console.log('   本地人机德州扑克  一键同步数据');
  console.log('============================================');
  console.log('');
  console.log('当前版本：' + ROOT);
  console.log('搜索旧版本目录：' + searchRoot);
  console.log('');

  let fromDir = null;
  if (args.from) {
    fromDir = path.resolve(args.from);
    if (!statSafe(fromDir)) {
      console.error('[错误] 指定的旧版本目录不存在：' + fromDir);
      return 1;
    }
    if (!isProjectRoot(fromDir)) {
      console.error('[错误] 该目录不是 local-holdem 项目（需包含 package.json 且 name 为 local-holdem）：' + fromDir);
      return 1;
    }
    if (fromDir === ROOT) {
      console.error('[错误] 旧版本目录与当前目录相同，无需同步。');
      return 1;
    }
  } else {
    if (candidates.length === 0) {
      console.log('没有在「' + searchRoot + '」下自动找到其他 local-holdem 目录。');
      console.log('');
      console.log('可以把旧版本文件夹放在当前版本旁边后重试，或手动指定路径，例如：');
      console.log('  node scripts/sync-data.mjs --from=../旧版本目录');
      console.log('  bash 一键同步数据.sh --from=../旧版本目录');
      console.log('');
      printCurrentData();
      return 1;
    }
    printCandidates(candidates);
    console.log('');
    if (candidates.length === 1) {
      fromDir = candidates[0].dir;
      console.log('自动选择唯一的旧版本目录。');
    } else if (args.yes) {
      fromDir = pickBestCandidate(candidates).dir;
      console.log('按要求自动选择数据最新的旧版本目录。');
    } else {
      const answer = await ask('请选择旧版本序号（回车默认 1，输入 q 取消）：');
      const text = String(answer ?? '').trim().toLowerCase();
      if (text === 'q' || text === 'quit') {
        console.log('已取消，未做任何修改。');
        return 0;
      }
      const index = text === '' ? 0 : Number(text) - 1;
      if (!Number.isInteger(index) || index < 0 || index >= candidates.length) {
        console.error('[错误] 无效的序号：' + answer);
        return 1;
      }
      fromDir = candidates[index].dir;
    }
  }

  const files = collectDataFiles(fromDir);
  if (files.length === 0) {
    console.error('[错误] 旧版本目录里没有找到可同步的数据文件：' + fromDir);
    return 1;
  }
  console.log('');
  console.log('旧版本数据文件：');
  for (const file of files) {
    console.log('  - ' + file.relPath + '  ' + formatBytes(file.size) + '  ' + formatTime(file.mtimeMs));
  }
  console.log('');
  printCurrentData();
  console.log('');

  if (!args.yes && !args.dryRun) {
    const answer = await ask('确认把这些数据同步到当前版本？（覆盖前会自动备份）[Y/n]：');
    const text = String(answer ?? '').trim().toLowerCase();
    if (text === 'n' || text === 'no') {
      console.log('已取消，未做任何修改。');
      return 0;
    }
  }

  const result = copySyncData({ fromDir, toDir: ROOT, dryRun: args.dryRun });
  printResult(result);
  return 0;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath && path.resolve(fileURLToPath(import.meta.url)) === invokedPath) {
  main().then((code) => {
    if (typeof code === 'number') process.exitCode = code;
  }).catch((error) => {
    console.error('[错误] ' + (error && error.message ? error.message : String(error)));
    process.exitCode = 1;
  });
}
