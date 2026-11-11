/**
 * 6 人桌配对的 A/B 差分：把「基线」与「变体」两批 `head2head6.ts` 的 JSONL（同一批 seed）
 * 做成逐 seed 配对差分。口径与 `head2head6-combine.ts` 一致：
 *   每个 (seed, hand) 的观测 d = (na + nb) / 2；先按 seed 取平均，再对 seed 求均值与 95% CI。
 *
 * 用法（`--` 前基线，后变体）：
 *   npx tsx scripts/head2head6-diff.ts tmp/h6-expert-*.jsonl -- tmp/h6-var-*.jsonl
 */
import { readFileSync } from 'node:fs';

interface Rec {
  seed: string;
  hand: number;
  na: number;
  nb: number;
}

const sep = process.argv.indexOf('--');
if (sep < 0 || sep === process.argv.length - 1 || sep === 2) {
  console.error('用法: npx tsx scripts/head2head6-diff.ts <基线.jsonl...> -- <变体.jsonl...>');
  process.exit(1);
}

function load(files: string[], label: string): Map<string, number> {
  const map = new Map<string, number>();
  for (const file of files) {
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      const rec = JSON.parse(line) as Rec;
      const key = `${rec.seed}#${rec.hand}`;
      if (map.has(key)) {
        console.error(`${label} 内部重复: ${key}（${file}）`);
        process.exit(1);
      }
      map.set(key, (rec.na + rec.nb) / 2);
    }
  }
  return map;
}

const base = load(process.argv.slice(2, sep), '基线');
const variant = load(process.argv.slice(sep + 1), '变体');
if (base.size !== variant.size) {
  console.error(`记录数不一致：基线 ${base.size} / 变体 ${variant.size}`);
  process.exit(1);
}
for (const key of base.keys()) {
  if (!variant.has(key)) {
    console.error(`seed/hand 对不上：基线有 ${key}，变体没有`);
    process.exit(1);
  }
}

// 按 seed 聚合：每个 seed 下所有 hand 的 (variant - baseline) 平均
const bySeed = new Map<string, number[]>();
for (const [key, baseValue] of base) {
  const seed = key.split('#')[0];
  const list = bySeed.get(seed) ?? [];
  list.push((variant.get(key) ?? 0) - baseValue);
  bySeed.set(seed, list);
}
const seeds = [...bySeed.keys()];
const seedMeans = seeds.map((seed) => {
  const values = bySeed.get(seed)!;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
});
const n = seedMeans.length;
const mean = seedMeans.reduce((sum, v) => sum + v, 0) / Math.max(1, n);
const variance = seedMeans.reduce((sum, v) => sum + (v - mean) ** 2, 0) / Math.max(1, n - 1);
const se = Math.sqrt(variance / Math.max(1, n));
const bb = (v: number) => Number(((v / 20) * 100).toFixed(1));
const bbSe = (v: number) => Number(((v / 20) * 100).toFixed(2));

console.log(
  JSON.stringify(
    {
      seeds: n,
      records: base.size,
      delta: {
        bbPer100: bb(mean),
        ci95: [bb(mean - 1.96 * se), bb(mean + 1.96 * se)],
        seBB100: bbSe(se),
        sdSeedBB: Number(((Math.sqrt(variance) / 20) * 100).toFixed(1)),
        significant: bb(mean - 1.96 * se) > 0 ? 'better' : bb(mean + 1.96 * se) < 0 ? 'worse' : 'noise',
      },
    },
    null,
    2,
  ),
);
