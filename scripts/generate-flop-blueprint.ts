/**
 * 离线生成翻牌蓝图。
 *
 * 步骤：
 *   1. 枚举全部 C(52,3)=22100 种翻牌，按纹理分桶，每个桶留一个代表翻牌；
 *   2. 在代表翻牌上枚举全部 1176 种底牌组合，按手牌强度分 10 桶；
 *   3. 桶对之间用蒙特卡洛算摊牌权益，得到 [桶][SB手牌桶][BB手牌桶] 的权益矩阵；
 *   4. 在翻牌树上跑 CFR+；
 *   5. 导出 src/ai/data/flop-blueprint.json。
 *
 * 用法：npx tsx scripts/generate-flop-blueprint.ts
 *      ITERATIONS=400 BUCKETS=48 npx tsx scripts/generate-flop-blueprint.ts
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
import { turnValueForward, type TurnValueWeights } from '../src/ai/solver/turnValue';

const ITERATIONS = Number(process.env.ITERATIONS ?? 400);
const MAX_BUCKETS = Number(process.env.BUCKETS ?? 48);
const HANDS_PER_BUCKET = Number(process.env.HANDS_PER_BUCKET ?? 10);
const MC_PER_PAIR = Number(process.env.MC ?? 40);
/** 单加注底池的剩余筹码（BB）：100BB − 3BB 开池。 */
const STACK_BB = 97;

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

/* 2)+3) 每个桶的权益矩阵 */
const rng = (() => {
  let state = 0x9e3779b9;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
})();

function buildEquityMatrix(board: Card[]): number[][] {
  // 枚举该翻牌上所有底牌组合并分桶
  const remaining = deck.filter((card) => !board.some((b) => b.rank === card.rank && b.suit === card.suit));
  const buckets: Array<Array<[Card, Card]>> = Array.from({ length: FLOP_HAND_BUCKETS }, () => []);
  for (let i = 0; i < remaining.length; i++) {
    for (let j = i + 1; j < remaining.length; j++) {
      const hole: [Card, Card] = [remaining[i], remaining[j]];
      buckets[flopHandBucket(hole, board)].push(hole);
    }
  }

  // 每桶抽样若干手，空桶用相邻桶兜底
  const reps = buckets.map((list) => {
    if (list.length === 0) return [] as Array<[Card, Card]>;
    const picked: Array<[Card, Card]> = [];
    const step = Math.max(1, Math.floor(list.length / HANDS_PER_BUCKET));
    for (let index = 0; index < list.length && picked.length < HANDS_PER_BUCKET; index += step) {
      picked.push(list[index]);
    }
    return picked;
  });
  for (let b = 0; b < FLOP_HAND_BUCKETS; b++) {
    if (reps[b].length > 0) continue;
    // 空桶：借用最近的非空桶，避免矩阵出现空洞
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
  const runoutPool = remaining;
  for (let i = 0; i < FLOP_HAND_BUCKETS; i++) {
    for (let j = 0; j < FLOP_HAND_BUCKETS; j++) {
      let score = 0;
      let samples = 0;
      for (let s = 0; s < MC_PER_PAIR; s++) {
        const hero = reps[i][Math.floor(rng() * Math.max(1, reps[i].length))];
        const villain = reps[j][Math.floor(rng() * Math.max(1, reps[j].length))];
        if (!hero || !villain) continue;
        if (hero[0].rank === villain[0].rank && hero[0].suit === villain[0].suit) continue;
        if (hero[0].rank === villain[1].rank && hero[0].suit === villain[1].suit) continue;
        if (hero[1].rank === villain[0].rank && hero[1].suit === villain[0].suit) continue;
        if (hero[1].rank === villain[1].rank && hero[1].suit === villain[1].suit) continue;
        const pool = runoutPool.filter(
          (card) =>
            !(card.rank === hero[0].rank && card.suit === hero[0].suit) &&
            !(card.rank === hero[1].rank && card.suit === hero[1].suit) &&
            !(card.rank === villain[0].rank && card.suit === villain[0].suit) &&
            !(card.rank === villain[1].rank && card.suit === villain[1].suit),
        );
        const runout = shuffle(pool, rng).slice(0, 2);
        const sign = showdownSign(hero, villain, [...board, ...runout]);
        score += sign > 0 ? 1 : sign === 0 ? 0.5 : 0;
        samples++;
      }
      matrix[i][j] = samples > 0 ? score / samples : 0.5;
    }
  }
  return matrix;
}

const started = Date.now();
const equity: number[][][] = [];
bucketBoards.forEach((board, index) => {
  equity.push(buildEquityMatrix(board));
  if ((index + 1) % 8 === 0) {
    console.log(`  权益矩阵 ${index + 1}/${bucketBoards.length}（${((Date.now() - started) / 1000).toFixed(0)}s）`);
  }
});
console.log(`权益矩阵完成：${((Date.now() - started) / 1000).toFixed(1)}s`);

/* 4) CFR+（可选：用价值网络当叶子估值） */
const USE_NET = process.env.USE_NET === '1';
let netWeights: TurnValueWeights | null = null;
if (USE_NET) {
  try {
    const raw = JSON.parse(readFileSync('src/ai/data/turn-value.json', 'utf8')) as {
      weights: TurnValueWeights;
      testR2: number;
    };
    netWeights = raw.weights;
    console.log(`叶子估值改用价值网络（留出集 R² ${raw.testR2}）`);
  } catch {
    console.log('读不到 turn-value.json，回退固定实现率');
  }
}

const boardHighOf = (key: string): number => {
  const band = key.split('|')[2];
  if (band === 'A') return 1;
  if (band === 'K') return 13 / 14;
  if (band === 'Q') return 12 / 14;
  if (band === 'JT') return 11 / 14;
  if (band === '98') return 9 / 14;
  return 6 / 14;
};
const pairedOf = (key: string): number => (key.startsWith('P') ? 1 : 0);

const solveStart = Date.now();
const blueprint = solveFlopBlueprint({
  bucketBoards,
  equity,
  iterations: ITERATIONS,
  leafEv: netWeights
    ? ({ flop, sbHand, bbHand, terminal }: { flop: number; sbHand: number; bbHand: number; terminal: FlopTerminal }) => {
        // 弃牌结局与网络无关，沿用原来的记账
        if (terminal.kind === 'fold') return flopTerminalEv(terminal, equity[flop][sbHand][bbHand]);
        const pot = Math.max(1, terminal.pot);
        const eq = equity[flop][sbHand][bbHand];
        const features = [
          (sbHand + 0.5) / FLOP_HAND_BUCKETS, // 成牌强度（用桶中点近似）
          (sbHand + 0.5) / FLOP_HAND_BUCKETS,
          0, // 听牌未知
          0,
          pairedOf(textureKeys[flop]),
          eq > 0.5 ? 1 : 0, // 超对代理：权益过半
          pot / 200,
          0, // 转牌起点无人下注
          Math.max(0, STACK_BB - terminal.investSb) / pot / 10,
          0.5, // 转牌未知
          boardHighOf(textureKeys[flop]),
          0,
        ];
        const evPerPot = turnValueForward(features, netWeights as TurnValueWeights);
        // 网络给的是「从转牌起还值多少」，减掉本街投入才是本街净收益
        return evPerPot * pot - terminal.investSb;
      }
    : undefined,
});
console.log(`CFR+ ${ITERATIONS} 次迭代：${((Date.now() - solveStart) / 1000).toFixed(1)}s，信息集 ${blueprint.entries.length}`);

/* 5) 导出 */
const payload = {
  generatedAt: new Date().toISOString(),
  description:
    'HU 单加注底池（SB 加注 3BB / BB 跟注）的翻牌 CFR+ 蓝图。' +
    '叶子用「权益 × 底池 × 权益实现率」估终局，等价于假设转河按固定实现率打完——这是已知限制。',
  iterations: ITERATIONS,
  handBuckets: FLOP_HAND_BUCKETS,
  textureKeys,
  bucketWeights,
  bucketBoards: bucketBoards.map((board) => board.map((card) => `${card.rank}${card.suit}`)),
  nodes: blueprint.nodes,
  entries: blueprint.entries,
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
