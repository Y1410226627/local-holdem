/**
 * 离线生成单挑翻前 CFR+ 蓝图。
 * 运行：npx tsx scripts/generate-preflop-blueprint.ts
 * 环境变量：ITERATIONS / REAL_IP / REAL_OOP / STACK_BB / ALLOW_LIMP / THREE_BET
 * 输出：src/ai/data/preflop-blueprint.json
 *
 * 默认值刻意与实战桌况一致：1000 筹码 / 20 大盲 = 50BB（见 DEFAULT_CONFIG），
 * 3-bet 用最小加注（`preflopActionOf` 实际能执行的唯一尺度）。
 * 求解器完全确定性（桶胜率矩阵用固定 seed 的 derivedRng，CFR 无随机性），
 * 同一组参数重跑两次，`entries` 逐位相同（只有 generatedAt 时间戳会变）。
 * 单机实测约 2.1ms/迭代，20 万次约 7 分钟。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { solvePreflopBlueprint } from '../src/ai/solver/preflop';
import type { PreflopThreeBet } from '../src/ai/solver/preflop';
import { preflopBucketTable } from '../src/ai/solver/abstraction';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'src/ai/data/preflop-blueprint.json');
const ITERATIONS = Number(process.env.ITERATIONS ?? 200000);
const REAL_IP = Number(process.env.REAL_IP ?? 1.05);
const REAL_OOP = Number(process.env.REAL_OOP ?? 0.95);
const STACK_BB = Number(process.env.STACK_BB ?? 50);
/**
 * 3-bet 几何，默认 `'min'`（= 运行时实际执行的最小加注 open+1BB）。
 * `THREE_BET=x3` 只用于复现旧抽象做对照，不要拿去上线。
 */
const THREE_BET = (process.env.THREE_BET ?? 'min') as PreflopThreeBet;
/**
 * 默认**不允许跛入**（`ALLOW_LIMP=1` 才开）。
 *
 * 现在在用的蓝图就是无跛入版：`sb_root` 只有 fold / raise 2.5 / raise 3.5。
 * 运行时的 `preflopNodeForView` 也没有把「SB 跛入后被加注」映射到任何节点，
 * 跛入分支解得再细也执行不到。默认值与产物保持一致，一条命令即可复现。
 */
const ALLOW_LIMP = process.env.ALLOW_LIMP === '1';

const started = Date.now();
const blueprint = solvePreflopBlueprint({
  iterations: ITERATIONS,
  realizationIp: REAL_IP,
  realizationOop: REAL_OOP,
  stackBB: STACK_BB,
  allowLimp: ALLOW_LIMP,
  threeBet: THREE_BET,
});
fs.writeFileSync(OUT, JSON.stringify(blueprint, null, 1) + '\n', 'utf8');

console.log(
  `wrote ${path.relative(ROOT, OUT)} (${(fs.statSync(OUT).size / 1024).toFixed(1)} KB), ` +
    `${blueprint.entries.length} entries, exploitability=${blueprint.exploitability} BB/hand, ` +
    `iters=${ITERATIONS}, stack=${STACK_BB}BB, threeBet=${THREE_BET}, realization=${REAL_IP}/${REAL_OOP}, ` +
    `limp=${ALLOW_LIMP}, ${((Date.now() - started) / 1000).toFixed(1)}s`,
);

const table = preflopBucketTable();

/** 一个起手牌类对应多少个具体组合（用于按真实发牌频率加权）。 */
function combosOfClass(key: string): number {
  if (!key) return 0;
  if (key.length === 2) return 6; // 对子
  return key.endsWith('s') ? 4 : 12;
}

function bucketMass(bucket: number): number {
  return (table.classesOfBucket[bucket] ?? []).reduce((sum, key) => sum + combosOfClass(key), 0);
}

function summarize(node: string): void {
  const spec = blueprint.nodes[node];
  const rows = blueprint.entries.filter((entry) => entry.node === node);
  if (!spec || rows.length === 0) return;
  const totals = new Array(spec.actions.length).fill(0);
  let mass = 0;
  for (const row of rows) {
    const weight = bucketMass(row.bucket);
    mass += weight;
    for (let index = 0; index < row.strategy.length; index++) {
      totals[index] += row.strategy[index] * weight;
    }
  }
  const text = spec.actions
    .map((action, index) => `${action}=${((totals[index] / Math.max(1, mass)) * 100).toFixed(1)}%`)
    .join('  ');
  console.log(`  ${node.padEnd(22)} ${text}`);
}

console.log('\n按真实组合数加权的总体频率：');
for (const node of ['sb_root', 'bb_vs_open_2.5', 'bb_vs_open_3.5', 'bb_vs_limp']) {
  summarize(node);
}

console.log('\nSB root（桶: fold / raise 2.5 / raise 3.5）');
for (const entry of blueprint.entries
  .filter((row) => row.node === 'sb_root')
  .sort((a, b) => a.bucket - b.bucket)) {
  const classes = table.classesOfBucket[entry.bucket] ?? [];
  console.log(
    `  ${String(entry.bucket).padStart(2)} [${classes[0]}..${classes[classes.length - 1]}]`.padEnd(26) +
      entry.strategy.map((v) => (v * 100).toFixed(0).padStart(3)).join(' / '),
  );
}
