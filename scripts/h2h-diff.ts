/**
 * 配对 A/B 差分：把「基线」与「变体」两批分片 JSONL（**同一批 seed**）做成逐 seed 配对差分。
 *
 * 为什么在仓库里：设计文档 T2 / T5 / T6 / T8 的验收全是「Δ ≥ 阈值且 CI 下界 > 0」，
 * 这些必须用配对差分，不能用两条单臂 CI 目测相减——同 seed 的两批对局牌运相同，
 * 实测逐 seed 差分的 sd 只有 4.3 BB（单臂 18.4），方差缩减 18 倍。这是验收工具，不是一次性诊断。
 *
 * 用法（`--` 前是基线，后是变体）：
 *   npx tsx scripts/h2h-diff.ts tmp/base/*.jsonl -- tmp/var/*.jsonl
 *
 * 统计口径与 `head2head.ts` 一致：每个 seed 的两局先取平均（= 一个观测），再对 H 个观测求标准误。
 *   d_k = mean(变体两局) − mean(基线两局)
 *   Δ   = mean(d_k)，SE = sd(d_k)/√H
 *
 * 校验（不满足直接 exit 1，不出数）：
 *   · 两批的 (hand, newSeat) 集合必须**完全一致**（种子区间相同、没有缺片/重复）
 *   · 任一批内部不得有重复 (hand, newSeat)
 */
import { readFileSync } from 'node:fs';

interface Rec {
  hand: number;
  seed: string;
  newSeat: number;
  net: number;
  arch?: string;
  newChallenge?: boolean;
  oldChallenge?: boolean;
  newSolver?: boolean;
  newExploit?: boolean;
  newBlueprint?: boolean;
  newBpRanges?: boolean;
  newBpGate?: boolean;
  newPfExploit?: boolean;
  newFlopBp?: boolean;
  newFlop?: boolean;
  oldDir?: string;
  stack?: number;
}

const sep = process.argv.indexOf('--');
if (sep < 0 || sep === process.argv.length - 1 || sep === 2) {
  console.error('用法: npx tsx scripts/_h2h-diff.ts <基线.jsonl...> -- <变体.jsonl...>');
  process.exit(1);
}
const baseFiles = process.argv.slice(2, sep);
const varFiles = process.argv.slice(sep + 1);

function load(files: string[], label: string): Map<string, Rec> {
  const map = new Map<string, Rec>();
  for (const file of files) {
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      const rec = JSON.parse(line) as Rec;
      const key = `${rec.hand}#${rec.newSeat}`;
      if (map.has(key)) {
        console.error(`${label} 内部重复: ${key}（${file}）`);
        process.exit(1);
      }
      map.set(key, rec);
    }
  }
  return map;
}

const base = load(baseFiles, '基线');
const variant = load(varFiles, '变体');

if (base.size !== variant.size) {
  console.error(`局数不一致：基线 ${base.size} / 变体 ${variant.size}（必须是同一批 seed）`);
  process.exit(1);
}
for (const key of base.keys()) {
  if (!variant.has(key)) {
    console.error(`seed/座位对不上：基线有 ${key}，变体没有。两批必须跑**同一段 HAND_START..HANDS**`);
    process.exit(1);
  }
  const b = base.get(key)!;
  const v = variant.get(key)!;
  if (b.seed !== v.seed) {
    console.error(`seed 不一致：${key} 基线 seed=${b.seed}、变体 seed=${v.seed}。配对差分要求同一批牌。`);
    process.exit(1);
  }
  for (const field of ['arch', 'newChallenge', 'oldChallenge', 'newSolver', 'newExploit', 'newBlueprint', 'newBpRanges', 'newBpGate', 'newPfExploit', 'newFlopBp', 'newFlop', 'oldDir', 'stack'] as const) {
    if (b[field] !== undefined || v[field] !== undefined) {
      if (b[field] !== v[field]) {
        console.error(`配置不一致：${key} 的 ${field} 基线=${String(b[field])}、变体=${String(v[field])}。A/B 只允许一个变量不同。`);
        process.exit(1);
      }
    }
  }
}

// 按 seed 聚成观测：每个 seed 一个 d_k
const hands = [...new Set([...base.values()].map((r) => r.hand))].sort((a, b) => a - b);
const ds: number[] = [];
const baseMeans: number[] = [];
const varMeans: number[] = [];
for (const h of hands) {
  const b0 = base.get(`${h}#0`)!.net;
  const b1 = base.get(`${h}#1`)!.net;
  const v0 = variant.get(`${h}#0`)!.net;
  const v1 = variant.get(`${h}#1`)!.net;
  const bm = (b0 + b1) / 2;
  const vm = (v0 + v1) / 2;
  baseMeans.push(bm);
  varMeans.push(vm);
  ds.push(vm - bm);
}

const H = ds.length;
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sd = (xs: number[]) => {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, xs.length - 1));
};

const dMean = mean(ds);
const dSd = sd(ds);
const dSe = dSd / Math.sqrt(H);
const bb = (v: number) => Number((v / 20 * 100).toFixed(1));
const bbSe = (v: number) => Number((v / 20 * 100).toFixed(2));

console.log(JSON.stringify({
  seeds: H,
  games: H * 2,
  baseline: { bbPer100: bb(mean(baseMeans)) },
  variant: { bbPer100: bb(mean(varMeans)) },
  delta: {
    bbPer100: bb(dMean),
    ci95: [bb(dMean - 1.96 * dSe), bb(dMean + 1.96 * dSe)],
    seBB100: bbSe(dSe),
    /** 逐 seed 差分的标准差（BB/手）；同 seed 配对会把牌运抵消，通常远小于单臂 18.4 */
    sdDiffBB: Number((dSd / 20).toFixed(2)),
    significant: bb(dMean - 1.96 * dSe) > 0 ? 'better' : bb(dMean + 1.96 * dSe) < 0 ? 'worse' : 'noise',
  },
}, null, 2));
