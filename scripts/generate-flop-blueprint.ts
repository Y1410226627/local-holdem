/**
 * 离线生成翻牌蓝图（A 路线）。
 *
 * 步骤：
 *   1. 枚举全部 C(52,3)=22100 种翻牌，按纹理分桶，每个桶留一个代表翻牌；
 *   2. 在代表翻牌上枚举全部 1176 种底牌组合，按手牌强度分桶；
 *   3. 桶对之间用蒙特卡洛算摊牌权益，得到 [桶][SB手牌桶][BB手牌桶] 的权益矩阵；
 *   4. 在翻牌树上跑 CFR+；
 *   5. 导出 src/ai/data/flop-blueprint.json。
 *
 * 用法：npx tsx scripts/generate-flop-blueprint.ts
 *      ITERATIONS=400 BUCKETS=48 HANDS=16 USE_NET=1 npx tsx scripts/generate-flop-blueprint.ts
 *
 * v0.24.0 的叶子估值修正：
 *   旧实现把「手牌桶下标」当成「成牌强度」、听牌恒填 0、转牌点数填 0.5 喂给价值网络，
 *   而网络是用**真实底牌 + 真实牌面**训练的——训练分布和推理分布完全不同，
 *   接进蓝图后 −8.9 BB/100 是必然的。
 *   现在改成：对每个 (翻牌桶, SB 手牌桶, BB 手牌桶) 抽若干**真实组合**与若干**真实转牌**，
 *   用真实牌面调用网络再取平均。这才是 DeepStack 那套「叶子用价值网络」的正确用法。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createDeck, shuffle } from '../src/game/cards';
import type { Card } from '../src/game/types';
import { showdownSign } from '../src/ai/solver/abstraction';
import {
  FLOP_HAND_BUCKETS,
  flopHandBucket,
  flopTextureKey,
  flopTerminalEv,
  solveFlopBlueprint,
  type FlopTerminal,
} from '../src/ai/solver/flopBlueprint';
import { turnValueFeaturesOf, turnValueForward, type TurnValueWeights } from '../src/ai/solver/turnValue';

const ITERATIONS = Number(process.env.ITERATIONS ?? 400);
const MAX_BUCKETS = Number(process.env.BUCKETS ?? 48);
const HANDS_PER_BUCKET = Number(process.env.HANDS ?? 8);
const MC_PER_PAIR = Number(process.env.MC ?? 40);
/** 叶子估值时每个手牌桶抽几个真实组合、每个组合抽几张转牌。 */
const LEAF_COMBOS = Number(process.env.LEAF_COMBOS ?? 5);
const LEAF_TURNS = Number(process.env.LEAF_TURNS ?? 4);
/** 「手对权益偏离」换算成筹码的系数（1 点权益 ≈ 1 个底池）。 */
const HAND_VS_HAND = Number(process.env.HAND_VS_HAND ?? 1);
/** 单加注底池的剩余筹码（BB）：100BB − 3BB 开池。 */
const STACK_BB = 97;
/** 蓝图内部以 BB 为单位；价值网络的「底池绝对规模」特征是按筹码训练的，换算时乘这个大盲。 */
const NOMINAL_BB = 20;

const deck = createDeck();

/* 1) 翻牌纹理分桶 */
const byKey = new Map<string, { board: Card[]; count: number }>();
for (let i = 0; i < deck.length; i++) {
  for (let j = i + 1; j < deck.length; j++) {
    for (let k = j + 1; k < deck.length; k++) {
      const board = [deck[i], deck[j], deck[k]];
      const key = flopTextureKey(board);
      const entry = byKey.get(key);
      if (entry) entry.count += 1;
      else byKey.set(key, { board, count: 1 });
    }
  }
}
const ordered = [...byKey.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, MAX_BUCKETS);
const textureKeys = ordered.map(([key]) => key);
const bucketBoards = ordered.map(([, value]) => value.board);
const bucketWeights = ordered.map(([, value]) => value.count);
console.log(`翻牌纹理桶：${byKey.size} 种，取前 ${textureKeys.length} 个（覆盖 ${(
  (bucketWeights.reduce((a, b) => a + b, 0) / 22100) * 100
).toFixed(1)}% 的翻牌）`);
console.log('桶示例：', textureKeys.slice(0, 6).join('  '));

/* 2)+3) 每个桶的权益矩阵 + 每个手牌桶的代表组合 */
const rng = (() => {
  let state = 0x9e3779b9;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
})();

type Combo = [Card, Card];

interface FlopData {
  matrix: number[][];
  reps: Combo[][];
  /** 该翻牌上所有未被占用的牌（抽转牌用）。 */
  remaining: Card[];
}

const sameCard = (a: Card, b: Card) => a.rank === b.rank && a.suit === b.suit;

function buildFlopData(board: Card[]): FlopData {
  const remaining = deck.filter(
    (card) => !board.some((b) => sameCard(b, card)),
  );
  const buckets: Combo[][] = Array.from({ length: FLOP_HAND_BUCKETS }, () => []);
  for (let i = 0; i < remaining.length; i++) {
    for (let j = i + 1; j < remaining.length; j++) {
      const hole: Combo = [remaining[i], remaining[j]];
      buckets[flopHandBucket(hole, board)].push(hole);
    }
  }

  // 每桶等距抽样若干手，空桶用相邻桶兜底
  const reps = buckets.map((list) => {
    if (list.length === 0) return [] as Combo[];
    const picked: Combo[] = [];
    const step = Math.max(1, Math.floor(list.length / HANDS_PER_BUCKET));
    for (let index = 0; index < list.length && picked.length < HANDS_PER_BUCKET; index += step) {
      picked.push(list[index]);
    }
    return picked;
  });
  for (let b = 0; b < FLOP_HAND_BUCKETS; b++) {
    if (reps[b].length > 0) continue;
    for (let offset = 1; offset < FLOP_HAND_BUCKETS; offset++) {
      const lo = b - offset;
      const hi = b + offset;
      if (lo >= 0 && reps[lo].length > 0) { reps[b] = reps[lo]; break; }
      if (hi < FLOP_HAND_BUCKETS && reps[hi].length > 0) { reps[b] = reps[hi]; break; }
    }
  }

  const matrix: number[][] = Array.from({ length: FLOP_HAND_BUCKETS }, () =>
    new Array<number>(FLOP_HAND_BUCKETS).fill(0.5),
  );
  for (let i = 0; i < FLOP_HAND_BUCKETS; i++) {
    for (let j = 0; j < FLOP_HAND_BUCKETS; j++) {
      let score = 0;
      let samples = 0;
      for (let s = 0; s < MC_PER_PAIR; s++) {
        const hero = reps[i][Math.floor(rng() * Math.max(1, reps[i].length))];
        const villain = reps[j][Math.floor(rng() * Math.max(1, reps[j].length))];
        if (!hero || !villain) continue;
        if (sameCard(hero[0], villain[0]) || sameCard(hero[0], villain[1])) continue;
        if (sameCard(hero[1], villain[0]) || sameCard(hero[1], villain[1])) continue;
        const pool = remaining.filter(
          (card) =>
            !sameCard(card, hero[0]) && !sameCard(card, hero[1]) &&
            !sameCard(card, villain[0]) && !sameCard(card, villain[1]),
        );
        const runout = shuffle(pool, rng).slice(0, 2);
        const sign = showdownSign(hero, villain, [...board, ...runout]);
        score += sign > 0 ? 1 : sign === 0 ? 0.5 : 0;
        samples++;
      }
      matrix[i][j] = samples > 0 ? score / samples : 0.5;
    }
  }
  return { matrix, reps, remaining };
}

const started = Date.now();
const flopData: FlopData[] = [];
bucketBoards.forEach((board, index) => {
  flopData.push(buildFlopData(board));
  if ((index + 1) % 8 === 0) {
    console.log(`  权益矩阵 ${index + 1}/${bucketBoards.length}（${((Date.now() - started) / 1000).toFixed(0)}s）`);
  }
});
const equity = flopData.map((data) => data.matrix);
console.log(`权益矩阵完成：${((Date.now() - started) / 1000).toFixed(1)}s`);

/* 4) CFR+（可选：用价值网络当叶子估值） */
const USE_NET = process.env.USE_NET === '1';
let netWeights: TurnValueWeights | null = null;
if (USE_NET) {
  try {
    const raw = JSON.parse(readFileSync('src/ai/data/turn-value.json', 'utf8')) as {
      weights: TurnValueWeights;
      testR2: number;
      features: number;
    };
    if (raw.features !== undefined && raw.features !== 24) {
      throw new Error(`价值网络特征维度 ${raw.features} 与当前 24 维不匹配，请重训`);
    }
    netWeights = raw.weights;
    console.log(`叶子估值改用价值网络（留出集 R² ${raw.testR2}）`);
  } catch (error) {
    console.log(`读不到可用的 turn-value.json（${String(error)}），回退固定实现率`);
  }
}

/**
 * 每个翻牌桶一个叶子估值器：真实牌面 → 价值网络 → 取平均。
 *
 * 关键点：网络吃的是**真实底牌 + 真实牌面**，和训练分布一致。
 * 之前喂桶下标 + 听牌恒 0，等于让网络在它从没见过的输入上外推。
 *
 * 记忆化：CFR 每个 (节点, 手牌桶对) 会被访问上千次，但终局参数完全相同，
 * 所以按「终局参数」缓存即可，实际只算一遍。
 */
function buildLeafEv(flop: number) {
  const data = flopData[flop];
  const board = bucketBoards[flop];
  const cache = new Map<string, number>();

  return (input: { sbHand: number; bbHand: number; terminal: FlopTerminal }): number => {
    const { terminal, sbHand, bbHand } = input;
    if (!netWeights) return flopTerminalEv(terminal, data.matrix[sbHand][bbHand]);
    // 弃牌结局与后续无关，沿用原来的记账
    if (terminal.kind === 'fold') {
      return flopTerminalEv(terminal, data.matrix[sbHand][bbHand]);
    }

    const key = `${sbHand}|${bbHand}|${terminal.pot}|${terminal.investSb}|${terminal.investBb}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;

    const sbReps = data.reps[sbHand] ?? [];
    const bbReps = data.reps[bbHand] ?? [];
    if (sbReps.length === 0 || bbReps.length === 0) {
      const fallback = flopTerminalEv(terminal, data.matrix[sbHand][bbHand]);
      cache.set(key, fallback);
      return fallback;
    }

    const potChips = terminal.pot * NOMINAL_BB;
    const stackSb = Math.max(1, (STACK_BB - terminal.investSb) * NOMINAL_BB);
    let sum = 0;
    let count = 0;
    for (let s = 0; s < LEAF_COMBOS; s++) {
      const sbCombo = sbReps[Math.floor(rng() * sbReps.length)];
      const bbCombo = bbReps[Math.floor(rng() * bbReps.length)];
      if (!sbCombo || !bbCombo) continue;
      if (
        sameCard(sbCombo[0], bbCombo[0]) || sameCard(sbCombo[0], bbCombo[1]) ||
        sameCard(sbCombo[1], bbCombo[0]) || sameCard(sbCombo[1], bbCombo[1])
      ) {
        continue;
      }
      const pool = data.remaining.filter(
        (card) =>
          !sameCard(card, sbCombo[0]) && !sameCard(card, sbCombo[1]) &&
          !sameCard(card, bbCombo[0]) && !sameCard(card, bbCombo[1]),
      );
      for (let t = 0; t < LEAF_TURNS; t++) {
        const turn = pool[Math.floor(rng() * pool.length)];
        if (!turn) continue;
        const features = turnValueFeaturesOf({
          hole: sbCombo,
          board: [...board, turn],
          pot: potChips,
          callAmount: 0, // 转牌起点，无人下注
          stack: stackSb,
          canCheck: true, // 大盲先行动，SB 此时可以过牌
        });
        const evPerPot = turnValueForward(features, netWeights);
        sum += evPerPot * terminal.pot - terminal.investSb;
        count++;
      }
    }
    const meanEv = count > 0 ? sum / count : flopTerminalEv(terminal, data.matrix[sbHand][bbHand]);
    // 网络给的是「SB 这手牌、面对对手整个范围」的期望值——它**不含 BB 的具体手牌**。
    // 但 CFR 需要一个 (SB 手牌, BB 手牌) 的收益矩阵，否则 BB 的所有手牌价值相同，
    // 求解出来就是「不分强弱乱下注」（实测 16 个桶的下注频率几乎一模一样）。
    //
    // 分解：payoff[h][v] = 均值[h] + 手对偏离[h][v]
    //   均值来自价值网络（含后续下注的价值），
    //   偏离来自摊牌权益相对该手牌平均权益的差（谁现在领先）。
    // 系数 HAND_VS_HAND 把「权益差」换算成筹码：摊牌时 1 点权益 ≈ 1 个底池。
    const equityHere = data.matrix[sbHand][bbHand];
    const deviation = (equityHere - avgEquity[flop][sbHand]) * terminal.pot * HAND_VS_HAND;
    const value = meanEv + deviation;
    cache.set(key, value);
    return value;
  };
}

/** 每个 (翻牌桶, SB 手牌桶) 对全部 BB 手牌桶的平均摊牌权益。 */
const avgEquity: number[][][] = equity.map((matrix) =>
  matrix.map((row) => row.reduce((a, b) => a + b, 0) / Math.max(1, row.length)),
);

const solveStart = Date.now();
const perFlopLeaf = netWeights ? bucketBoards.map((_, flop) => buildLeafEv(flop)) : null;
const blueprint = solveFlopBlueprint({
  bucketBoards,
  equity,
  iterations: ITERATIONS,
  leafEv: perFlopLeaf
    ? (input) => perFlopLeaf[input.flop](input)
    : undefined,
});
console.log(`CFR+ ${ITERATIONS} 次迭代：${((Date.now() - solveStart) / 1000).toFixed(1)}s，信息集 ${blueprint.entries.length}`);

/* 5) 导出 */
const payload = {
  generatedAt: new Date().toISOString(),
  description: netWeights
    ? 'HU 单加注底池（SB 加注 3BB / BB 跟注）的翻牌 CFR+ 蓝图。叶子用转牌价值网络（真实牌面）估终局。'
    : 'HU 单加注底池（SB 加注 3BB / BB 跟注）的翻牌 CFR+ 蓝图。叶子用「权益 × 底池 × 权益实现率」估终局，等价于假设转河按固定实现率打完——这是已知限制。',
  iterations: ITERATIONS,
  handBuckets: FLOP_HAND_BUCKETS,
  leaf: netWeights ? 'turn-value-net' : 'equity-realization',
  textureKeys,
  bucketWeights,
  bucketBoards: bucketBoards.map((board) => board.map((card) => `${card.rank}${card.suit}`)),
  nodes: blueprint.nodes,
  // 策略量化成 0~100 的整数（加载时除以 strategyScale）：
  // 浮点原始值每个要占 10+ 个字符，量化后只占 1~3 个，文件从 1.2MB 降到 ~0.6MB。
  // 精度损失 0.5% 对混合频率没有实际影响（决策本来就是按频率抽样）。
  strategyScale: 100,
  entries: blueprint.entries.map((entry) => ({
    ...entry,
    strategy: entry.strategy.map((value) => Math.round(value * 100)),
  })),
};
const out = 'src/ai/data/flop-blueprint.json';
writeFileSync(out, JSON.stringify(payload), 'utf8');
console.log(`已写入 ${out}（${(JSON.stringify(payload).length / 1024).toFixed(0)} KB）`);

/* 摘要：几个关键节点的平均策略 */
for (const node of ['bb_root', 'sb_after_check']) {
  const rows = blueprint.entries.filter((entry) => entry.node === node);
  if (rows.length === 0) continue;
  const actions = blueprint.nodes[node];
  console.log(`\n${node}（${actions.join(' / ')}）按手牌桶平均：`);
  for (let hand = 0; hand < FLOP_HAND_BUCKETS; hand++) {
    const subset = rows.filter((row) => row.hand === hand);
    if (subset.length === 0) continue;
    const avg = actions.map((_, index) =>
      subset.reduce((sum, row) => sum + (row.strategy[index] ?? 0), 0) / subset.length,
    );
    console.log(`  桶 ${hand}: ${avg.map((v) => (v * 100).toFixed(0).padStart(3)).join(' / ')}`);
  }
}
