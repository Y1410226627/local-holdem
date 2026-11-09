/**
 * 翻前蓝图离线验收（重训后必须先跑这个，再看对局测量）。
 *
 * 用法：npx tsx scripts/audit-preflop-blueprint.ts
 * 环境变量：STACK_BB（默认 50，= 实战桌况 1000/20）、GATE（默认 0.02 BB/手）、
 *          PROBE（自检迭代数，默认 2000）
 *
 * 做四件事：
 * 1. 等价性自检——用 `evaluatePreflopBlueprint` 重算一份**刚解出来的**蓝图，
 *    必须等于求解器自报的 `exploitability`。等价性不成立，后面所有数字都不作数。
 * 2. 一致性检查——重算仓库里那份产物的可利用度，和它自己写的 `exploitability` 比。
 *    差太多说明产物是旧代码生成的（v0.25 那份写 0.0167，实际 0.0470）。
 * 3. 验收——按**运行时真实动作几何**（3-bet = 最小加注、全下 → sb_vs_allin）
 *    算可利用度，这是唯一能代表「上线后能被执行的东西」的口径。
 * 4. 打印四格矩阵（3-bet 几何 × 全下映射），把口径 bug 的账单独算清楚。
 *
 * 注意：可利用度是**抽象博弈内**的指标，不是对真人的期望收益；
 * 它只能用来比「同一棵树上的两份策略」，或者比「口径对不对」。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { solvePreflopBlueprint } from '../src/ai/solver/preflop';
import type { PreflopBlueprint } from '../src/ai/solver/preflop';
import {
  BLUEPRINT_STACK_MAX_BB,
  BLUEPRINT_STACK_MIN_BB,
} from '../src/ai/solver/preflop';
import { evaluatePreflopBlueprint } from '../src/ai/solver/blueprintEval';
import { preflopBucketTable } from '../src/ai/solver/abstraction';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'src/ai/data/preflop-blueprint.json');
const STACK = Number(process.env.STACK_BB ?? 50);
/** 验收门槛：运行时口径下的可利用度上限（BB/手）。 */
const GATE = Number(process.env.GATE ?? 0.02);
/** 自报值与重算值允许的最大偏差。超过就是「产物与代码不一致」。 */
const STALE = 5e-3;

const fmt = (value: number): string => value.toFixed(4);
const signed = (value: number): string => `${value >= 0 ? '+' : ''}${fmt(value)}`;

/* ---------------- 1. 等价性自检 ---------------- */
const probeIters = Number(process.env.PROBE ?? 2000);
const probe = solvePreflopBlueprint({ iterations: probeIters, stackBB: STACK, allowLimp: false });
const probeEval = evaluatePreflopBlueprint(probe, { stackBB: STACK, threeBet: probe.threeBet, jamMapping: 'correct' });
const delta = Math.abs(probeEval.exploitability - probe.exploitability);
console.log(
  `[自检] ${probeIters} 次迭代：求解器自报 expl=${fmt(probe.exploitability)}，` +
    `独立重算 expl=${fmt(probeEval.exploitability)}，差=${delta.toExponential(2)}`,
);
if (delta > STALE) {
  console.error('[自检] 失败：评估器与求解器不等价，后续数字不可信。');
  process.exit(1);
}

/* ---------------- 2. 一致性检查 ---------------- */
const blueprint = JSON.parse(fs.readFileSync(FILE, 'utf8')) as PreflopBlueprint;
const intended = blueprint.threeBet ?? 'x3';
console.log(
  `\n[产物] ${path.relative(ROOT, FILE)}  stackBB=${blueprint.stackBB}  buckets=${blueprint.buckets}  ` +
    `iters=${blueprint.iterations}  3bet=${intended}  limp=${blueprint.allowLimp ?? '未记录'}  ` +
    `entries=${blueprint.entries.length}  自报 expl=${fmt(blueprint.exploitability)}`,
);
const inTraining = evaluatePreflopBlueprint(blueprint, {
  stackBB: blueprint.stackBB,
  threeBet: intended,
  jamMapping: 'correct',
});
const stale = Math.abs(inTraining.exploitability - blueprint.exploitability);
console.log(
  `[一致性] 训练口径下重算 expl=${fmt(inTraining.exploitability)}，与自报值差=${stale.toExponential(2)}` +
    (stale > STALE ? '  ← 产物是旧代码生成的，请重新生成' : '  ← 一致'),
);
if (stale > STALE) process.exit(1);

/* ---------------- 3. 验收：运行时真实口径 ---------------- */
const runtime = evaluatePreflopBlueprint(blueprint, {
  stackBB: STACK,
  threeBet: 'min',
  jamMapping: 'correct',
});
console.log(
  `\n[验收 · 运行时口径 ${STACK}BB] V=${fmt(runtime.value)} brSb=${fmt(runtime.bestResponseSb)} ` +
    `brBb=${fmt(runtime.bestResponseBb)} expl=${fmt(runtime.exploitability)}`,
);
if (runtime.exploitability > GATE) {
  console.error(`[验收] 失败：运行时口径可利用度 ${fmt(runtime.exploitability)} > 门槛 ${GATE}`);
  process.exit(1);
}
console.log(`[验收] 通过：${fmt(runtime.exploitability)} ≤ 门槛 ${GATE}`);

/* ---------------- 4. 四格矩阵（口径账） ---------------- */
const cell = (threeBet: 'min' | 'x3', jamMapping: 'correct' | 'legacy'): number =>
  evaluatePreflopBlueprint(blueprint, { stackBB: STACK, threeBet, jamMapping }).exploitability;
const mm = cell('min', 'correct');
const mb = cell('min', 'legacy');
const xm = cell('x3', 'correct');
const xb = cell('x3', 'legacy');
console.log(
  `\n[口径矩阵 ${STACK}BB]  全下映射 correct / legacy\n` +
    `  3-bet=min（运行时实际）  ${fmt(mm)} / ${fmt(mb)}   ← 全下误映射 ${signed(mb - mm)}\n` +
    `  3-bet=x3 （旧抽象）      ${fmt(xm)} / ${fmt(xb)}   ← 全下误映射 ${signed(xb - xm)}\n` +
    `  3-bet 尺度差（correct）  ${signed(xm - mm)}`,
);

/* ---------------- 5. 深度曲线（闸门阈值的依据） ---------------- */
const stacksEnv = process.env.STACKS;
if (stacksEnv) {
  const list = stacksEnv.split(',').map((v) => Number(v.trim())).filter((v) => v > 0);
  console.log('\n[深度曲线] 同一份蓝图放进不同深度的同一套抽象（全下分支对深度最敏感）：');
  for (const depth of list) {
    const result = evaluatePreflopBlueprint(blueprint, {
      stackBB: depth,
      threeBet: 'min',
      jamMapping: 'correct',
    });
    const inside = depth >= BLUEPRINT_STACK_MIN_BB && depth <= BLUEPRINT_STACK_MAX_BB;
    console.log(
      `  ${String(depth).padStart(3)}BB  expl=${fmt(result.exploitability)}  V=${fmt(result.value)}  ` +
        `${inside ? '闸门内' : '闸门外'}`,
    );
  }
  console.log(
    `  闸门 = [${BLUEPRINT_STACK_MIN_BB}, ${BLUEPRINT_STACK_MAX_BB}]BB（训练深度的 ±40%）`,
  );
}

/* ---------------- 6. 频率表（人眼检查） ---------------- */
const table = preflopBucketTable();
const combosOf = (key: string): number => (key.length === 2 ? 6 : key.endsWith('s') ? 4 : 12);
console.log('\n按真实组合数加权的总体频率（人眼检查用，不是验收指标）：');
for (const node of Object.keys(blueprint.nodes)) {
  const spec = blueprint.nodes[node];
  const totals = new Array(spec.actions.length).fill(0);
  let mass = 0;
  for (const entry of blueprint.entries.filter((row) => row.node === node)) {
    const weight = (table.classesOfBucket[entry.bucket] ?? []).reduce((sum, key) => sum + combosOf(key), 0);
    mass += weight;
    for (let index = 0; index < entry.strategy.length; index++) {
      totals[index] += entry.strategy[index] * weight;
    }
  }
  const text = spec.actions
    .map((action, index) => `${action}=${((totals[index] / Math.max(1, mass)) * 100).toFixed(1)}%`)
    .join('  ');
  console.log(`  ${node.padEnd(20)} ${text}`);
}
