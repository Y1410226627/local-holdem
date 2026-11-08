/**
 * HLB 差分：把同 bot、同 seed 的两条 JSONL（挑战档 / 专家档）做成逐手配对差分。
 *
 * 为什么必须配对：两档跑的是**同一批牌**（`hlb-bots.ts` 的 seed 不含档位），
 * 逐手相减后牌运抵消。**不要拿两个单臂 CI 目测相减**——那会把配对信息扔掉。
 *
 * 用法：
 *   npx tsx scripts/hlb-compare.ts tmp/hlb-3bc-ch.jsonl tmp/hlb-3bc-ex.jsonl
 *   第一个参数 = 挑战档，第二个 = 专家档。
 *
 * 判定（PRD A3-a 非退化，两级门槛的第一级）：
 *   · `regression = 差分 CI **上界** < 0` → 判负，必须定位原因（先查是引擎还是 bot 本身有问题，不自动回滚）
 *   · 否则 `OK`：只说明「没有证据表明变弱」，不等于变强
 *   A3-b（强度 +50）**不在本脚本判定**，只在主指标（15,200 局 head2head）上验。
 *
 * 校验：两份必须同 bot、同手数、手号一一对应、档位标记正确，否则 exit 1（防止拿错文件）。
 */
import { readFileSync } from 'node:fs';

interface Rec { hand: number; bot: string; challenge: number; net: number }

function load(file: string): Rec[] {
  const recs: Rec[] = [];
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    recs.push(JSON.parse(line) as Rec);
  }
  return recs;
}

const [chFile, exFile] = process.argv.slice(2);
if (!chFile || !exFile) {
  console.error('用法: npx tsx scripts/hlb-compare.ts <挑战档.jsonl> <专家档.jsonl>');
  process.exit(1);
}

const ch = load(chFile);
const ex = load(exFile);

if (ch.length !== ex.length) {
  console.error(`手数不一致：挑战档 ${ch.length} 手 / 专家档 ${ex.length} 手`);
  process.exit(1);
}
if (ch[0]?.bot !== ex[0]?.bot) {
  console.error(`bot 不一致：${ch[0]?.bot} vs ${ex[0]?.bot}`);
  process.exit(1);
}
if (ch.some((r) => r.challenge !== 1) || ex.some((r) => r.challenge !== 0)) {
  console.error('档位标记不对：第一名必须是 CHALLENGE=1，第二名必须是 CHALLENGE=0');
  process.exit(1);
}
const exByHand = new Map(ex.map((r) => [r.hand, r.net]));
for (const r of ch) {
  if (!exByHand.has(r.hand)) {
    console.error(`手号对不上：挑战档有 hand=${r.hand}，专家档没有`);
    process.exit(1);
  }
}

const bb = (v: number) => Number((v / 20 * 100).toFixed(1));
const stats = (xs: number[]) => {
  const n = xs.length;
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const varr = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1);
  const se = Math.sqrt(varr / n);
  return { n, mean, se, ci: [bb(mean - 1.96 * se), bb(mean + 1.96 * se)] as [number, number] };
};

const chNets = ch.map((r) => r.net);
const exNets = ch.map((r) => exByHand.get(r.hand)!);
const diffs = chNets.map((v, i) => v - exNets[i]);
const d = stats(diffs);
const a = stats(chNets);
const b = stats(exNets);

console.log(JSON.stringify({
  bot: ch[0].bot,
  hands: d.n,
  challenge: { bbPer100: bb(a.mean), ci95: a.ci },
  expert: { bbPer100: bb(b.mean), ci95: b.ci },
  diff: {
    bbPer100: bb(d.mean),
    ci95: d.ci,
    seBB100: Number((d.se / 20 * 100).toFixed(2)),
    /** 逐手差分的标准差（BB/手）：用来反推「要多少手才够」，见 PRD A3-a 的样本量估算 */
    sdDiffBB: Number((Math.sqrt(diffs.reduce((s, v) => s + (v - d.mean) ** 2, 0) / Math.max(1, d.n - 1)) / 20).toFixed(2)),
  },
  /**
   * A3-a 非退化判定（PRD 两级门槛的第一级）：
   * 差分 CI **上界** < 0 才判负；否则 OK（=「没有证据表明变弱」，不等于变强）。
   * A3-b（强度 +50）不在这里判，只在主指标 15,200 局 head2head 上验。
   */
  verdict: d.ci[1] < 0 ? 'REGRESSION' : 'OK',
  regression: d.ci[1] < 0,
}, null, 2));
