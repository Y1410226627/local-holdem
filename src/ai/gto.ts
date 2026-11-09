/**
 * GTO / 纳什均衡近似层（按难度调节「接近程度」）。
 *
 * 评估：完整 NLHE 的 GTO 是超大博弈（信息集数量巨大），在本地浏览器/Node 里
 * 做全树 CFR 不现实。这里采用两层可验证的近似：
 *
 * 1) **均衡频率公式**（可严格推导）：MDF（最小防守频率）、诈唬比例 α、
 *    价值/诈唬比、底池赔率临界混合——用于翻牌后的边界混合、平衡诈唬与尺度混合；
 * 2) **抽象 CFR 求解器**：单挑短码（≤12BB）push/fold 游戏，按起手牌强度 10 桶抽象，
 *    用 169 类起手牌的桶间全下胜率矩阵跑 CFR，得到近似纳什推/弃与跟/弃频率。
 *
 * 各难度用 `GTO_CLOSENESS` 把「启发式策略」与「均衡策略」混合：
 * 入门几乎纯启发式，普通/困难/专家逐步提高，挑战宗师最接近均衡（≈92%）。
 * 注意：这是近似而非无漏洞；抽象桶、单街/短码限制都让真实可利用性 > 0。
 */
import type { Card, Difficulty, LegalActions, PlayerAction, Rank, Suit } from '../game/types';
import type { PlayerView } from '../game/playerView';
import { createDeck, derivedRng, shuffle } from '../game/cards';
import { compareHands, evaluate7 } from '../game/handEvaluator';
import { preflopClasses, preflopStrength } from './rangeModel';

export type GtoDifficultyLevel = Difficulty | 'challenge';

/** 均衡接近度（0 = 纯启发式，1 = 完全按抽象均衡策略）。 */
export const GTO_CLOSENESS: Record<GtoDifficultyLevel, number> = {
  beginner: 0.02,
  normal: 0.12,
  hard: 0.3,
  expert: 0.55,
  // 0.92：实测调到 1.0 后 Δ=+1.2 [-2.5, +4.9]（15,200 局配对），
  // CI 上界 < +10，无法证明存在有意义的收益，按三态规则保持原值。
  challenge: 0.92,
};

export function gtoClosenessFor(difficulty: Difficulty, challenge: boolean): number {
  return challenge ? GTO_CLOSENESS.challenge : GTO_CLOSENESS[difficulty];
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/* ------------------------------------------------------------------ */
/* 1) 均衡频率公式                                                      */
/* ------------------------------------------------------------------ */

/** 面对 pot 大小的下注时，理论上需要继续的最小范围比例（MDF）。 */
export function minimumDefenseFrequency(pot: number, bet: number): number {
  if (bet <= 0) return 1;
  return clamp01(pot / (pot + bet));
}

/** 下注者最优诈唬比例 α = bet / (pot + 2*bet)（占其下注范围的比例）。 */
export function bluffFractionForSize(pot: number, bet: number): number {
  if (bet <= 0) return 0;
  return clamp01(bet / (pot + 2 * bet));
}

/** 均衡价值/诈唬比 V:B = (pot + bet) : bet。 */
export function bluffToValueRatio(pot: number, bet: number): number {
  if (bet <= 0) return 0;
  return clamp01(bet / (pot + bet));
}

/** 跟注者在均衡下需要的胜率（= 底池赔率）。 */
export function equilibriumCallThreshold(pot: number, bet: number): number {
  if (bet <= 0) return 0;
  return clamp01(bet / (pot + 2 * bet));
}

/** 把启发式诈唬概率向均衡比例混合：closeness 越高越接近 α。 */
export function gtoBluffChance(
  heuristicChance: number,
  closeness: number,
  pot: number,
  bet: number,
): number {
  const target = bluffFractionForSize(pot, bet);
  const k = clamp01(closeness);
  return clamp01(heuristicChance * (1 - k) + target * k);
}

export interface GtoBoundaryInput {
  action: PlayerAction;
  equity: number;
  potOdds: number;
  legal: LegalActions;
  closeness: number;
  rng: () => number;
}

/**
 * 边界混合：当胜率接近底池赔率临界（在均衡中应当混合）时，按 closeness 概率
 * 在跟注 / 弃牌之间切换；closeness 越高越像均衡的混合策略。
 */
export function gtoBoundaryAdjust(input: GtoBoundaryInput): {
  action: PlayerAction;
  note: string;
} | null {
  const { action, equity, potOdds, legal, closeness, rng } = input;
  if (closeness < 0.2) return null;
  const distance = Math.abs(equity - potOdds);
  if (distance > 0.055) return null;
  const k = clamp01(closeness);
  const mixChance = 0.5 * k;
  if (action.type === 'fold' && legal.canCall && rng() < mixChance) {
    return {
      action: { type: 'call' },
      note: '（GTO 边界混合：接近底池赔率临界，按均衡频率防守）',
    };
  }
  if (action.type === 'call' && legal.canFold && rng() < mixChance * 0.7) {
    return {
      action: { type: 'fold' },
      note: '（GTO 边界混合：临界牌按均衡频率弃牌，避免被诈唬剥削）',
    };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 2) 单挑短码 push/fold 的抽象 CFR 求解器                              */
/* ------------------------------------------------------------------ */

export const PUSH_FOLD_BUCKETS = 10;
export const PUSH_FOLD_STACK_BB = 10;
const PUSH_FOLD_EQUITY_SAMPLES = 160;

export interface PushFoldSolution {
  buckets: number;
  stackBB: number;
  iterations: number;
  /** 按强度桶（0 最弱）：SB 全下频率。 */
  sbPushFrequency: number[];
  /** 按强度桶：BB 面对全下时的跟注频率。 */
  bbCallFrequency: number[];
  /** 桶的起手牌强度下界（长度 buckets-1）。 */
  boundaries: number[];
  /** 抽象游戏的可利用度（BB/手，越小越接近纳什）。 */
  exploitability: number;
}

const RANK_LABELS_LOCAL: Record<string, Rank> = {
  '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
  T: 10, J: 11, Q: 12, K: 13, A: 14,
};

function rankFromText(text: string): Rank | null {
  if (text === '10') return 10;
  return RANK_LABELS_LOCAL[text] ?? null;
}

function parseCombo(key: string): [Card, Card] {
  const match = /^(10|[2-9TJQKA])(10|[2-9TJQKA])([so]?)$/.exec(key);
  if (!match) throw new Error('无法解析起手牌：' + key);
  const high = rankFromText(match[1]);
  const low = rankFromText(match[2]);
  const suffix = match[3];
  if (!high || !low) throw new Error('无法解析起手牌：' + key);
  if (high === low) return [{ rank: high, suit: 's' }, { rank: low, suit: 'h' }];
  if (suffix === 's') return [{ rank: high, suit: 's' }, { rank: low, suit: 's' }];
  return [{ rank: high, suit: 's' }, { rank: low, suit: 'h' }];
}

interface BucketTable {
  boundaries: number[];
  reps: Array<[Card, Card]>;
}

let bucketTableCache: BucketTable | null = null;

function buildBucketTable(): BucketTable {
  if (bucketTableCache) return bucketTableCache;
  const classes = preflopClasses(); // 169 个，按强度升序
  const buckets = PUSH_FOLD_BUCKETS;
  const perBucket = classes.length / buckets;
  const boundaries: number[] = [];
  const reps: Array<[Card, Card]> = [];
  for (let bucket = 0; bucket < buckets; bucket++) {
    const start = Math.floor(bucket * perBucket);
    const end = Math.min(classes.length - 1, Math.floor((bucket + 1) * perBucket) - 1);
    const median = classes[Math.min(classes.length - 1, Math.floor((start + end) / 2))];
    reps.push(parseCombo(median.key));
    if (bucket > 0) boundaries.push(classes[start]?.strength ?? 0);
  }
  bucketTableCache = { boundaries, reps };
  return bucketTableCache;
}

export function bucketOfStrength(strength: number, boundaries: readonly number[]): number {
  let bucket = 0;
  for (let index = 0; index < boundaries.length; index++) {
    if (strength >= boundaries[index]) bucket = index + 1;
    else break;
  }
  return Math.min(bucket, boundaries.length);
}

interface EquityMatrix {
  /** equity[i][j]：桶 i 对桶 j 的全下胜率（平局按半胜）。 */
  equity: number[][];
  buckets: number;
}

let equityMatrixCache: EquityMatrix | null = null;

function buildEquityMatrix(): EquityMatrix {
  if (equityMatrixCache) return equityMatrixCache;
  const { reps } = buildBucketTable();
  const buckets = reps.length;
  const equity = Array.from({ length: buckets }, () => new Array<number>(buckets).fill(0.5));
  const rng = derivedRng('gto-pushfold-equity');
  for (let i = 0; i < buckets; i++) {
    for (let j = i; j < buckets; j++) {
      const hero = reps[i];
      const villain = reps[j];
      const used = new Set([hero[0], hero[1], villain[0], villain[1]].map((card) => `${card.rank}${card.suit}`));
      const deck = createDeck().filter((card) => !used.has(`${card.rank}${card.suit}`));
      let score = 0;
      for (let sample = 0; sample < PUSH_FOLD_EQUITY_SAMPLES; sample++) {
        const board = shuffle(deck, rng).slice(0, 5);
        const heroHand = evaluate7([hero[0], hero[1], ...board]);
        const villainHand = evaluate7([villain[0], villain[1], ...board]);
        const result = compareHands(heroHand, villainHand);
        if (result > 0) score += 1;
        else if (result === 0) score += 0.5;
      }
      const value = score / PUSH_FOLD_EQUITY_SAMPLES;
      equity[i][j] = value;
      equity[j][i] = 1 - value;
    }
  }
  equityMatrixCache = { equity, buckets };
  return equityMatrixCache;
}

function regretMatching(regrets: readonly number[]): number[] {
  const positive = regrets.map((value) => Math.max(0, value));
  const sum = positive.reduce((total, value) => total + value, 0);
  if (sum <= 1e-12) return positive.map(() => 0.5);
  return positive.map((value) => value / sum);
}

export interface PushFoldOptions {
  iterations?: number;
  stackBB?: number;
  /** 绕过缓存（测试不同迭代表现用）。 */
  bypassCache?: boolean;
}

/**
 * 用 CFR 求解单挑短码 push/fold 抽象游戏。
 * SB（按钮）可选 push / fold；BB 面对 push 可选 call / fold；
 * 全下后直接按桶间胜率摊牌。返回平均策略与可利用度。
 */
/**
 * 用「阈值纯策略 + 正则型 CFR」求解抽象 push/fold 游戏：
 * - SB 纯策略按阈值 t：对强度桶 >= t 全下（t = buckets 表示全部弃牌）；
 * - BB 纯策略按阈值 c：对强度桶 >= c 跟注（c = buckets 表示全部弃牌）。
 * 在 11×11 的矩阵博弈上跑 CFR（遗憾匹配 + CFR+ 裁剪 + 线性加权平均），
 * 得到混合阈值策略；按桶边际得到「越强越常推 / 跟」的频率。
 * 这是带抽象（10 桶、阈值结构）的近似纳什解，可利用度仍 > 0。
 */
export function solvePushFold(options: PushFoldOptions = {}): PushFoldSolution {
  const iterations = Math.max(10, Math.floor(options.iterations ?? 2000));
  const stackBB = options.stackBB ?? PUSH_FOLD_STACK_BB;
  const cacheKey = stackBB + ':' + iterations;
  if (!options.bypassCache && pushFoldCache.has(cacheKey)) {
    return pushFoldCache.get(cacheKey)!;
  }
  const { equity, buckets } = buildEquityMatrix();
  const { boundaries } = buildBucketTable();
  const actionCount = buckets + 1; // 阈值 0..buckets

  // 预计算阈值策略的收益矩阵：matrix[sbThreshold][bbThreshold] = SB 期望。
  const matrix: number[][] = Array.from({ length: actionCount }, () =>
    new Array<number>(actionCount).fill(0),
  );
  for (let t = 0; t < actionCount; t++) {
    for (let c = 0; c < actionCount; c++) {
      let total = 0;
      for (let i = 0; i < buckets; i++) {
        for (let j = 0; j < buckets; j++) {
          const sbPushes = i >= t;
          const bbCalls = j >= c;
          if (!sbPushes) {
            total += -0.5;
          } else if (bbCalls) {
            total += stackBB * (2 * equity[i][j] - 1);
          } else {
            total += 1;
          }
        }
      }
      matrix[t][c] = total / (buckets * buckets);
    }
  }

  const sbRegret = new Array<number>(actionCount).fill(0);
  const bbRegret = new Array<number>(actionCount).fill(0);
  const sbSum = new Array<number>(actionCount).fill(0);
  const bbSum = new Array<number>(actionCount).fill(0);

  for (let iteration = 1; iteration <= iterations; iteration++) {
    const sbStrategy = regretMatching(sbRegret);
    const bbStrategy = regretMatching(bbRegret);
    const sbEv = new Array<number>(actionCount).fill(0);
    for (let t = 0; t < actionCount; t++) {
      let value = 0;
      for (let c = 0; c < actionCount; c++) value += matrix[t][c] * bbStrategy[c];
      sbEv[t] = value;
    }
    const sbValue = sbEv.reduce((sum, value, index) => sum + value * sbStrategy[index], 0);
    for (let t = 0; t < actionCount; t++) {
      sbRegret[t] = Math.max(0, sbRegret[t] + (sbEv[t] - sbValue));
      sbSum[t] += iteration * sbStrategy[t];
    }
    const bbEv = new Array<number>(actionCount).fill(0);
    for (let c = 0; c < actionCount; c++) {
      let value = 0;
      for (let t = 0; t < actionCount; t++) value += -matrix[t][c] * sbStrategy[t];
      bbEv[c] = value;
    }
    const bbValue = -sbValue;
    for (let c = 0; c < actionCount; c++) {
      bbRegret[c] = Math.max(0, bbRegret[c] + (bbEv[c] - bbValue));
      bbSum[c] += iteration * bbStrategy[c];
    }
  }

  const normalize = (values: readonly number[]): number[] => {
    const total = values.reduce((sum, value) => sum + value, 0);
    if (total <= 1e-12) return values.map(() => 1 / values.length);
    return values.map((value) => value / total);
  };
  const sbThresholdMix = normalize(sbSum);
  const bbThresholdMix = normalize(bbSum);
  const sbPushFrequency: number[] = [];
  const bbCallFrequency: number[] = [];
  for (let bucket = 0; bucket < buckets; bucket++) {
    // 阈值 t <= bucket 的策略都会推这个桶 → 边际全下频率。
    sbPushFrequency.push(
      sbThresholdMix.slice(0, bucket + 1).reduce((sum, weight) => sum + weight, 0),
    );
    bbCallFrequency.push(
      bbThresholdMix.slice(0, bucket + 1).reduce((sum, weight) => sum + weight, 0),
    );
  }

  // 矩阵博弈的可利用度（阈值策略空间内）：
  const expectedSb = (sbMixed: number[], bbMixed: number[]): number => {
    let value = 0;
    for (let t = 0; t < actionCount; t++) {
      for (let c = 0; c < actionCount; c++) value += sbMixed[t] * bbMixed[c] * matrix[t][c];
    }
    return value;
  };
  const value = expectedSb(sbThresholdMix, bbThresholdMix);
  let bestSb = -Infinity;
  for (let t = 0; t < actionCount; t++) {
    let row = 0;
    for (let c = 0; c < actionCount; c++) row += matrix[t][c] * bbThresholdMix[c];
    bestSb = Math.max(bestSb, row);
  }
  let bestBb = -Infinity;
  for (let c = 0; c < actionCount; c++) {
    let column = 0;
    for (let t = 0; t < actionCount; t++) column += -matrix[t][c] * sbThresholdMix[t];
    bestBb = Math.max(bestBb, column);
  }
  const exploitability = Math.max(0, bestSb - value) + Math.max(0, bestBb + value);

  const solution: PushFoldSolution = {
    buckets,
    stackBB,
    iterations,
    sbPushFrequency,
    bbCallFrequency,
    boundaries,
    exploitability,
  };
  pushFoldCache.set(cacheKey, solution);
  return solution;
}

const pushFoldCache = new Map<string, PushFoldSolution>();

/* ------------------------------------------------------------------ */
/* 3) 尺度混合（避免固定尺度被针对）                                    */
/* ------------------------------------------------------------------ */

export interface GtoSizeInput {
  fractions: readonly number[];
  pot: number;
  equity: number;
  currentBet: number;
  callAmount: number;
  legal: LegalActions;
  foldToBetRate: number | null;
  opponentCount: number;
  closeness: number;
  rng: () => number;
}

/**
 * 按 EV 的 softmax 混合下注尺度：closeness 越高越接近「混合均衡尺度」，
 * 越低越接近直接挑 EV 最大（可预测 / 可被针对）。
 */
export function gtoEvSizeChoice(input: GtoSizeInput): { fraction: number; note: string } {
  const {
    fractions,
    pot,
    equity,
    currentBet,
    callAmount,
    legal,
    foldToBetRate,
    opponentCount,
    closeness,
    rng,
  } = input;
  if (fractions.length === 0) return { fraction: 0.5, note: '无可用尺度' };
  const candidates = fractions.length > 1 ? fractions : [fractions[0]];
  const values = candidates.map((fraction) => {
    const target = currentBet + (pot + callAmount) * fraction;
    const betChips = Math.max(1, target - currentBet);
    const foldProbability = Math.min(
      0.85,
      Math.max(0.05, 0.3 + fraction * 0.16 + (foldToBetRate ?? 0.45) * 0.15),
    );
    const foldAll = Math.pow(foldProbability, Math.max(1, opponentCount));
    const calledEv = equity * (pot + 2 * betChips) - betChips;
    return foldAll * pot + (1 - foldAll) * calledEv;
  });
  const max = Math.max(...values);
  const temperature = Math.max(0.5, pot * 0.18);
  const weights = values.map((value) => Math.exp((value - max) / temperature));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const k = clamp01(closeness);
  if (rng() < k) {
    // 按 softmax 混合尺度（均衡式随机化）。
    let roll = rng();
    for (let index = 0; index < candidates.length; index++) {
      roll -= weights[index] / total;
      if (roll <= 0) {
        return { fraction: candidates[index], note: '（GTO 尺度混合）' };
      }
    }
    return { fraction: candidates[candidates.length - 1], note: '（GTO 尺度混合）' };
  }
  let bestIndex = 0;
  for (let index = 1; index < values.length; index++) {
    if (values[index] > values[bestIndex]) bestIndex = index;
  }
  return { fraction: candidates[bestIndex], note: '' };
}
