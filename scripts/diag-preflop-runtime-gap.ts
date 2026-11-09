/**
 * 诊断：抽象 ↔ 运行时口径差（3-bet 尺度 / 全下映射）值多少钱。
 *
 * 用法：
 *   npx tsx scripts/diag-preflop-runtime-gap.ts [blueprint.json ...]
 *   STACK_BB=50 npx tsx scripts/diag-preflop-runtime-gap.ts tmp/old.json src/ai/data/preflop-blueprint.json
 *
 * 背景（两个真实存在过的口径 bug，都用这个脚本量化出来的）：
 * 1. **全下误映射**：`preflopNodeForView` 只数「加注次数」，把全下当成普通加注，
 *    于是 BB 全下之后 SB 拿到的是 `sb_vs_3bet_*`（按 7.5BB 3-bet 解出来的防守范围），
 *    而不是 `sb_vs_allin_*`。修前 AI 面对 50BB 全下在跟注 46%。
 * 2. **3-bet 尺度**：`preflopActionOf` 把 `raise_big` 一律折算成 3.5BB，
 *    面对 2.5BB 开池正好是最小加注 3.5BB、面对 3.5BB 开池被 clamp 到 4.5BB，
 *    两种情况都等于 open+1BB——而旧抽象树里是 open×3。
 *
 * 矩阵四格都是「同一份蓝图 + 同一个评估器」，只改口径，所以差值可以直接读作
 * 「这个口径 bug 造成的可利用度增量」。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluatePreflopBlueprint } from '../src/ai/solver/blueprintEval';
import type { PreflopBlueprint } from '../src/ai/solver/preflop';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STACK = Number(process.env.STACK_BB ?? 50);
const files = process.argv.slice(2).length > 0
  ? process.argv.slice(2)
  : [path.join(ROOT, 'src/ai/data/preflop-blueprint.json')];

const fmt = (value: number): string => value.toFixed(4);
const signed = (value: number): string => `${value >= 0 ? '+' : ''}${fmt(value)}`;

for (const file of files) {
  const abs = path.isAbsolute(file) ? file : path.join(ROOT, file);
  if (!fs.existsSync(abs)) {
    console.log(`跳过（不存在）：${file}`);
    continue;
  }
  const bp = JSON.parse(fs.readFileSync(abs, 'utf8')) as PreflopBlueprint;
  const intended = bp.threeBet ?? 'x3';
  const cell = (threeBet: 'min' | 'x3', jamMapping: 'correct' | 'legacy'): number =>
    evaluatePreflopBlueprint(bp, { stackBB: STACK, threeBet, jamMapping }).exploitability;

  const mm = cell('min', 'correct');
  const mb = cell('min', 'legacy');
  const xm = cell('x3', 'correct');
  const xb = cell('x3', 'legacy');

  console.log(`\n=== ${path.relative(ROOT, abs)}`);
  console.log(
    `    stackBB=${bp.stackBB}  iters=${bp.iterations}  训出时的 3bet=${intended}  ` +
      `limp=${bp.allowLimp ?? '未记录'}  自报 expl=${fmt(bp.exploitability)}`,
  );
  console.log(`    评估深度：${STACK}BB（实战桌况 1000 筹码 / 20 大盲）`);
  console.log('                       全下映射 correct   legacy');
  console.log(`    3-bet=min (运行时实际)   ${fmt(mm)}          ${fmt(mb)}`);
  console.log(`    3-bet=x3  (旧抽象)       ${fmt(xm)}          ${fmt(xb)}`);
  console.log(
    `    全下误映射的代价（min 口径）：${signed(mb - mm)} BB/手` +
      `　｜　3-bet 尺度差的代价（correct 口径）：${signed(xm - mm)} BB/手`,
  );
  console.log(
    `    「训练口径 = 运行时口径」那一格：${fmt(intended === 'min' ? mm : xm)}` +
      (intended === 'min' ? '（3bet=min × jam=correct）' : '（3bet=x3 × jam=correct）'),
  );
}
