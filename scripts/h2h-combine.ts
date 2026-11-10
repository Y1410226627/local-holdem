/**
 * 合并 `h2h-shard.ts` 的分片 JSONL，输出总统计 + 一致性检查。
 *
 * 用法：
 *   npx tsx scripts/h2h-combine.ts tmp/h2h-*.jsonl
 *
 * **读哪个 CI（最容易踩的坑）**：`pairedBySeed.ci95` 才是正确口径，
 * 顶层 `ci95` 只是「把同 seed 的两局当独立样本」的旧算法，保留是为了和历史数字逐位对账。
 * 同 seed 的两局共用同一副牌、强正相关（挑战 vs 专家实测 ρ≈0.42），旧算法把标准误
 * 低估 √(1+ρ) 倍；两边同档同代码时 ρ 恰好 = 1，旧算法低估 √2，有效样本只有一半。
 *
 * 检查项（任一不满足直接 exit 1，不输出统计）：
 *   1. 同一 (hand, newSeat) 出现多次 → 重复，报错（有人把同一片喂了两遍）；
 *   2. hand 在 [min, max] 区间内有缺口，或某手的 newSeat=0/1 缺一边 → 样本不完整，报错；
 *   3. net 不是有限数 → 运行出错，报错。
 *
 * 统计口径与 head2head.ts 一致：mean / ddof=1 的 var / se = sqrt(var/n) / BB100 = mean/20*100（1 位小数）。
 * 配对口径：同一 seed 两局（第二局已取负号）求和，Var(均值) = Var(S)/(4H)——与 head2head 的
 * 「先求 pairMeans 再求标准误」在代数上完全等价，实测两条路径输出逐位相同。
 */
import { readFileSync } from 'node:fs';

interface Rec { hand: number; seed: string; newSeat: number; net: number }

const files = process.argv.slice(2);
const EXPECT_START = process.env.EXPECT_HAND_START ? Number(process.env.EXPECT_HAND_START) : null;
const EXPECT_HANDS = process.env.EXPECT_HANDS ? Number(process.env.EXPECT_HANDS) : null;
if (files.length === 0) {
  console.error('用法: npx tsx scripts/h2h-combine.ts <分片.jsonl> [更多...]');
  process.exit(1);
}

const byKey = new Map<string, Rec>();
const dups: string[] = [];
let total = 0;

for (const file of files) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    total++;
    let rec: Rec;
    try {
      rec = JSON.parse(line) as Rec;
    } catch {
      console.error(`解析失败: ${file}: ${line.slice(0, 120)}`);
      process.exit(1);
    }
    if (!Number.isFinite(rec.net) || typeof rec.hand !== 'number' || (rec.newSeat !== 0 && rec.newSeat !== 1)) {
      console.error(`字段非法: ${file}: ${line.slice(0, 120)}`);
      process.exit(1);
    }
    const key = `${rec.hand}#${rec.newSeat}`;
    if (byKey.has(key)) dups.push(`${key}（${file}）`);
    else byKey.set(key, rec);
  }
}

if (dups.length > 0) {
  console.error(`发现重复记录 ${dups.length} 条，前 5 条: ${dups.slice(0, 5).join(', ')}`);
  console.error('（同一 (hand,newSeat) 只能出现一次；检查是不是把同一分片喂了两遍）');
  process.exit(1);
}

const hands = [...new Set([...byKey.values()].map((r) => r.hand))].sort((a, b) => a - b);
const minHand = hands[0];
const maxHand = hands[hands.length - 1];
if (EXPECT_START !== null && minHand !== EXPECT_START) {
  console.error(`起始手号不符：期望 ${EXPECT_START}，实际 ${minHand}（可能缺头部分片）`);
  process.exit(1);
}
if (EXPECT_HANDS !== null && hands.length !== EXPECT_HANDS) {
  console.error(`手数不符：期望 ${EXPECT_HANDS} 个 seed，实际 ${hands.length} 个（可能缺尾部分片）`);
  process.exit(1);
}
const missing: string[] = [];
for (let h = minHand; h <= maxHand; h++) {
  const a = byKey.get(`${h}#0`);
  const b = byKey.get(`${h}#1`);
  if (!a && !b) missing.push(`${h}(两手都缺)`);
  else if (!a) missing.push(`${h}#0`);
  else if (!b) missing.push(`${h}#1`);
}
if (missing.length > 0) {
  console.error(`手数区间 ${minHand}..${maxHand} 不完整，缺 ${missing.length} 项，前 10 项: ${missing.slice(0, 10).join(', ')}`);
  process.exit(1);
}

const recs = [...byKey.values()];
const nets = recs.map((r) => r.net);
const n = nets.length;
const mean = nets.reduce((a, b) => a + b, 0) / n;
const varr = nets.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1);
const sd = Math.sqrt(varr);
const se = Math.sqrt(varr / n);
const bb = (v: number) => Number((v / 20 * 100).toFixed(1));

// 配对口径：同一 seed 两局相加（第二局已经取过负号），Var(mean) = Var(S)/(4H)
const sums = hands.map((h) => byKey.get(`${h}#0`)!.net + byKey.get(`${h}#1`)!.net);
const H = sums.length;
const sMean = sums.reduce((a, b) => a + b, 0) / H;
const sVar = sums.reduce((a, b) => a + (b - sMean) ** 2, 0) / Math.max(1, H - 1);
const sePaired = Math.sqrt(sVar / (4 * H));

// 相关系数（同 seed 两局）
const xs = hands.map((h) => byKey.get(`${h}#0`)!.net);
const ys = hands.map((h) => byKey.get(`${h}#1`)!.net);
const mx = xs.reduce((a, b) => a + b, 0) / H;
const my = ys.reduce((a, b) => a + b, 0) / H;
let cov = 0, vx = 0, vy = 0;
for (let i = 0; i < H; i++) {
  cov += (xs[i] - mx) * (ys[i] - my);
  vx += (xs[i] - mx) ** 2;
  vy += (ys[i] - my) ** 2;
}
const corr = cov / Math.sqrt(vx * vy);

console.log(JSON.stringify({
  files: files.length,
  recordsRead: total,
  games: n,
  seeds: H,
  handRange: [minHand, maxHand],
  bbPer100: bb(mean),
  // 顶层 ci95 是旧口径，只用于对账；结论请读 pairedBySeed.ci95（见文件头说明）。
  ci95: [bb(mean - 1.96 * se), bb(mean + 1.96 * se)],
  sdChips: Number(sd.toFixed(2)),
  sdBB: Number((sd / 20).toFixed(3)),
  seBB100: Number((se * 5).toFixed(3)),
  pairedBySeed: {
    seBB100: Number((sePaired * 5).toFixed(3)),
    ci95: [bb(mean - 1.96 * sePaired), bb(mean + 1.96 * sePaired)],
    corrSameSeed: Number(corr.toFixed(4)),
  },
}, null, 2));
