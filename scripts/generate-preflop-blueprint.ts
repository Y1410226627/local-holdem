/**
 * 离线生成单挑翻前 CFR+ 蓝图。
 * 运行：npx tsx scripts/generate-preflop-blueprint.ts
 * 环境变量：ITERATIONS / REAL_IP / REAL_OOP / STACK_BB
 * 输出：src/ai/data/preflop-blueprint.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { solvePreflopBlueprint } from '../src/ai/solver/preflop';
import { preflopBucketTable } from '../src/ai/solver/abstraction';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'src/ai/data/preflop-blueprint.json');
const ITERATIONS = Number(process.env.ITERATIONS ?? 40000);
const REAL_IP = Number(process.env.REAL_IP ?? 1.05);
const REAL_OOP = Number(process.env.REAL_OOP ?? 0.95);
const STACK_BB = Number(process.env.STACK_BB ?? 100);
const ALLOW_LIMP = process.env.ALLOW_LIMP !== '0';

const started = Date.now();
const blueprint = solvePreflopBlueprint({
  iterations: ITERATIONS,
  realizationIp: REAL_IP,
  realizationOop: REAL_OOP,
  stackBB: STACK_BB,
  allowLimp: ALLOW_LIMP,
});
fs.writeFileSync(OUT, JSON.stringify(blueprint, null, 1) + '\n', 'utf8');

console.log(
  `wrote ${path.relative(ROOT, OUT)} (${(fs.statSync(OUT).size / 1024).toFixed(1)} KB), ` +
    `${blueprint.entries.length} entries, exploitability=${blueprint.exploitability} BB/hand, ` +
    `iters=${ITERATIONS}, realization=${REAL_IP}/${REAL_OOP}, limp=${ALLOW_LIMP}, ${((Date.now() - started) / 1000).toFixed(1)}s`,
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

console.log('\nSB root（桶: fold / limp / raise2.5 / raise3.5）');
for (const entry of blueprint.entries
  .filter((row) => row.node === 'sb_root')
  .sort((a, b) => a.bucket - b.bucket)) {
  const classes = table.classesOfBucket[entry.bucket] ?? [];
  console.log(
    `  ${String(entry.bucket).padStart(2)} [${classes[0]}..${classes[classes.length - 1]}]`.padEnd(26) +
      entry.strategy.map((v) => (v * 100).toFixed(0).padStart(3)).join(' / '),
  );
}
