/**
 * 离线生成 GTO 查表（方案 B1）：
 * 对单挑短码 push/fold 抽象游戏，按不同有效筹码深度跑阈值策略 CFR，
 * 把 SB 全下频率 / BB 跟注频率写成 JSON，运行时直接查表（+ 线性插值），
 * 避免每次决策重复求解。运行：npm run gto:tables
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { solvePushFold } from '../src/ai/gto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'src/ai/data/gto-pushfold.json');
const MIN_STACK_BB = 4;
const MAX_STACK_BB = 20;
const ITERATIONS = 3000;

const entries = [];
let boundaries: number[] = [];
for (let stackBB = MIN_STACK_BB; stackBB <= MAX_STACK_BB; stackBB++) {
  const solution = solvePushFold({ stackBB, iterations: ITERATIONS, bypassCache: true });
  boundaries = solution.boundaries;
  entries.push({
    stackBB,
    sbPushFrequency: solution.sbPushFrequency.map((value) => Number(value.toFixed(4))),
    bbCallFrequency: solution.bbCallFrequency.map((value) => Number(value.toFixed(4))),
    exploitability: Number(solution.exploitability.toFixed(4)),
  });
  console.log(
    `stack=${stackBB}BB push=[${solution.sbPushFrequency.map((v) => Math.round(v * 100)).join(',')}] ` +
      `call=[${solution.bbCallFrequency.map((v) => Math.round(v * 100)).join(',')}] ` +
      `exploitability=${solution.exploitability.toFixed(3)}`,
  );
}

const table = {
  generatedAt: new Date().toISOString(),
  description: '单挑短码 push/fold 阈值策略 CFR 查表（12 起手牌强度桶，4-20BB）',
  buckets: entries[0] ? entries[0].sbPushFrequency.length : 0,
  stackMinBB: MIN_STACK_BB,
  stackMaxBB: MAX_STACK_BB,
  iterations: ITERATIONS,
  boundaries: boundaries.map((value) => Number(value.toFixed(4))),
  entries,
};
fs.writeFileSync(OUT, JSON.stringify(table, null, 1) + '\n', 'utf8');
const size = fs.statSync(OUT).size;
console.log(`wrote ${path.relative(ROOT, OUT)} (${(size / 1024).toFixed(1)} KB), ${entries.length} 个筹码深度`);
