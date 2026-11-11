/**
 * 合并 `head2head6.ts` 的分片，输出 6 人桌「挑战组 vs 对照组」的配对强度。
 *
 * 统计口径：每个 (seed, hand) 的配对观测 d = (na + nb) / 2（两桌镜像、同一副牌），
 * 先按 seed 取平均（一个 seed 一个观测），再对 seed 求均值与 95% CI（ddof=1）。
 * `bbPer100` = 每手净赢 / 20 × 100（20 筹码 = 1 BB）。
 */
import { readFileSync } from 'node:fs';

interface Rec {
  seed: string;
  hand: number;
  na: number;
  nb: number;
}

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('用法: npx tsx scripts/head2head6-combine.ts <分片.jsonl...>');
  process.exit(1);
}

const bySeed = new Map<string, number[]>();
let total = 0;
for (const file of files) {
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const rec = JSON.parse(line) as Rec;
    total++;
    const list = bySeed.get(rec.seed) ?? [];
    list.push((rec.na + rec.nb) / 2);
    bySeed.set(rec.seed, list);
  }
}

const seeds = [...bySeed.keys()];
const seedMeans = seeds.map((seed) => {
  const values = bySeed.get(seed)!;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
});
const n = seedMeans.length;
const mean = seedMeans.reduce((sum, v) => sum + v, 0) / Math.max(1, n);
const variance =
  seedMeans.reduce((sum, v) => sum + (v - mean) ** 2, 0) / Math.max(1, n - 1);
const se = Math.sqrt(variance / Math.max(1, n));
const bb = (v: number) => Number(((v / 20) * 100).toFixed(1));
const bbSe = (v: number) => Number(((v / 20) * 100).toFixed(2));

console.log(
  JSON.stringify(
    {
      files: files.length,
      records: total,
      seeds: n,
      challengeChipsPerHand: Number(mean.toFixed(2)),
      bbPer100: bb(mean),
      ci95: [bb(mean - 1.96 * se), bb(mean + 1.96 * se)],
      seBB100: bbSe(se),
      sdSeedBB: Number(((Math.sqrt(variance) / 20) * 100).toFixed(1)),
      significant: bb(mean - 1.96 * se) > 0 ? 'better' : bb(mean + 1.96 * se) < 0 ? 'worse' : 'noise',
    },
    null,
    2,
  ),
);
