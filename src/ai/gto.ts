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
export function solvePushFold(options: PushFoldOptions = {}): PushFoldSolution {
  const iterations = Math.max(10, Math.floor(options.iterations ?? 1500));
  const stackBB = options.stackBB ?? PUSH_FOLD_STACK_BB;
  const cacheKey = stackBB + ':' + iterations;
  if (!options.bypassCache && pushFoldCache.has(cacheKey)) {
    return pushFoldCache.get(cacheKey)!;
  }
  const { equity, buckets } = buildEquityMatrix();
  const { boundaries } = buildBucketTable();
  const sbRegret: number[][] = Array.from({ length: buckets }, () => [0, 0]);
  const bbRegret: number[][] = Array.from({ length: buckets }, () => [0, 0]);
  const sbStrategySum: number[][] = Array.from({ length: buckets }, () => [0, 0]);
  const bbStrategySum: number[][] = Array.from({ length: buckets }, () => [0, 0]);

  // CFR+：遗憾值裁剪到 0、线性加权平均；先更新 SB，再用更新后的 SB 策略更新 BB。
  for (let iteration = 1; iteration <= iterations; iteration++) {
    const weight = iteration;
    const sbStrategies: number[][] = [];
    const bbStrategies: number[][] = [];
    for (let index = 0; index < buckets; index++) {
      sbStrategies.push(regretMatching(sbRegret[index]));
      bbStrategies.push(regretMatching(bbRegret[index]));
    }
    // SB 更新：SB 桶 i 对 BB 各桶等概率，BB 使用当前平均策略。
    for (let i = 0; i < buckets; i++) {
      const sbStrategy = sbStrategies[i];
      let evPush = 0;
      for (let j = 0; j < buckets; j++) {
        const callPayoff = stackBB * (2 * equity[i][j] - 1);
        const bbStrategy = bbStrategies[j];
        evPush += bbStrategy[1] * callPayoff + bbStrategy[0] * 1;
      }
      const evFold = -0.5 * buckets;
      const evSum = sbStrategy[0] * evFold + sbStrategy[1] * evPush;
      sbRegret[i][0] = Math.max(0, sbRegret[i][0] + (evFold - evSum));
      sbRegret[i][1] = Math.max(0, sbRegret[i][1] + (evPush - evSum));
      sbStrategySum[i][0] += weight * sbStrategy[0];
      sbStrategySum[i][1] += weight * sbStrategy[1];
    }
    // BB 更新：对每个 BB 桶 j，SB 各桶的到达概率 = 其当前 push 频率。
    for (let j = 0; j < buckets; j++) {
      const bbStrategy = bbStrategies[j];
      let pushReach = 0;
      let foldCounterfactual = 0;
      let callCounterfactual = 0;
      let strategyCounterfactual = 0;
      for (let i = 0; i < buckets; i++) {
        const pushProbability = sbStrategies[i][1];
        pushReach += pushProbability;
        const callPayoff = stackBB * (2 * equity[i][j] - 1);
        const foldValue = pushProbability * -1 + (1 - pushProbability) * 0.5;
        const callValue = pushProbability * -callPayoff + (1 - pushProbability) * 0.5;
        foldCounterfactual += foldValue;
        callCounterfactual += callValue;
        strategyCounterfactual += bbStrategy[0] * foldValue + bbStrategy[1] * callValue;
      }
      pushReach /= buckets;
      bbRegret[j][0] = Math.max(0, bbRegret[j][0] + (foldCounterfactual - strategyCounterfactual));
      bbRegret[j][1] = Math.max(0, bbRegret[j][1] + (callCounterfactual - strategyCounterfactual));
      bbStrategySum[j][0] += weight * bbStrategy[0];
      bbStrategySum[j][1] += weight * bbStrategy[1];
    }
  }

  const sbPushFrequency: number[] = [];
  const bbCallFrequency: number[] = [];
  for (let i = 0; i < buckets; i++) {
    const sbTotal = sbStrategySum[i][0] + sbStrategySum[i][1];
    sbPushFrequency.push(sbTotal > 0 ? sbStrategySum[i][1] / sbTotal : 0.5);
    const bbTotal = bbStrategySum[i][0] + bbStrategySum[i][1];
    bbCallFrequency.push(bbTotal > 0 ? bbStrategySum[i][1] / bbTotal : 0);
  }
  const monotonePush = isotonicIncreasing(sbPushFrequency);
  const monotoneCall = isotonicIncreasing(bbCallFrequency);
  const exploitability = estimateExploitability(monotonePush, monotoneCall, equity, stackBB);
  const solution: PushFoldSolution = {
    buckets,
    stackBB,
    iterations,
    sbPushFrequency: monotonePush,
    bbCallFrequency: monotoneCall,
    boundaries,
    exploitability,
  };
  pushFoldCache.set(cacheKey, solution);
  return solution;
}

const pushFoldCache = new Map<string, PushFoldSolution>();

/** 保序回归（相邻递增）：把噪声频率投影为随牌力单调不减的策略。 */
function isotonicIncreasing(values: readonly number[]): number[] {
  const result = values.slice();
  for (let index = 1; index < result.length; index++) {
    if (result[index] < result[index - 1]) result[index] = result[index - 1];
  }
  return result;
}

function estimateExploitability(
  sbPush: readonly number[],
  bbCall: readonly number[],
  equity: readonly number[][],
  stackBB: number,
): number {
  const buckets = sbPush.length;
  const uniform = 1 / buckets;
  const evAgainstSb = (i: number, sbPushStrategy: readonly number[], bbCallStrategy: readonly number[]): number => {
    // 给定 SB 策略与 BB 策略下 SB 的期望（均匀权重）。
    let total = 0;
    for (let j = 0; j < buckets; j++) {
      const callPayoff = stackBB * (2 * equity[i][j] - 1);
      const evPush = bbCallStrategy[j] * callPayoff + (1 - bbCallStrategy[j]) * 1;
      total += sbPushStrategy[i] * evPush + (1 - sbPushStrategy[i]) * -0.5;
    }
    return total / buckets;
  };
  const value = (() => {
    let total = 0;
    for (let i = 0; i < buckets; i++) {
      for (let j = 0; j < buckets; j++) {
        const callPayoff = stackBB * (2 * equity[i][j] - 1);
        const evPush = bbCall[j] * callPayoff + (1 - bbCall[j]) * 1;
        total += sbPush[i] * evPush + (1 - sbPush[i]) * -0.5;
      }
    }
    return total / (buckets * buckets);
  })();
  // SB 最佳响应
  let brSb = -Infinity;
  for (let i = 0; i < buckets; i++) {
    let foldEv = 0;
    let pushEv = 0;
    for (let j = 0; j < buckets; j++) {
      foldEv += -0.5;
      const callPayoff = stackBB * (2 * equity[i][j] - 1);
      pushEv += bbCall[j] * callPayoff + (1 - bbCall[j]) * 1;
    }
    brSb = Math.max(brSb, Math.max(foldEv, pushEv) / buckets);
  }
  // BB 最佳响应（对 SB 的平均策略）
  let brBb = -Infinity;
  let pushWeight = 0;
  for (let i = 0; i < buckets; i++) pushWeight += sbPush[i] / buckets;
  for (let j = 0; j < buckets; j++) {
    let foldEv = 0;
    let callEv = 0;
    for (let i = 0; i < buckets; i++) {
      const callPayoff = stackBB * (2 * equity[i][j] - 1);
      foldEv += sbPush[i] * -1 + (1 - sbPush[i]) * 0.5;
      callEv += sbPush[i] * -callPayoff + (1 - sbPush[i]) * 0.5;
    }
    brBb = Math.max(brBb, Math.max(foldEv, callEv) / buckets);
  }
  void uniform;
  // BB 的 BR 收益换算成 SB 视角的损失。
  const sbLossFromBbBr = brBb + value; // BB BR EV - BB 在均衡下的 EV(=-value)
  return Math.max(0, brSb - value) + Math.max(0, sbLossFromBbBr);
}

export interface PushFoldAdvice {
  action: 'push' | 'fold' | 'call';
  /** 均衡频率下的对应动作概率。 */
  frequency: number;
  bucket: number;
  note: string;
}

/**
 * 单挑短码（≤12BB）的 GTO 推/弃、跟/弃建议；不满足条件返回 null。
 * 只读取公开信息（位置、筹码、底牌）。
 */
export function gtoPushFoldAdvice(view: PlayerView): PushFoldAdvice | null {
  if (view.street !== 'preflop') return null;
  const opponents = view.players.filter(
    (player) => player.id !== view.viewerId && (player.status === 'active' || player.status === 'allin'),
  );
  if (opponents.length !== 1) return null;
  // 全下后对手 stack 可能为 0，用「身后筹码 + 本轮已投入」估算有效筹码。
  const effectiveStack = Math.min(
    view.self.stack + view.self.totalCommitted,
    opponents[0].stack + opponents[0].totalCommitted,
  );
  if (effectiveStack > 12 * view.bigBlind || effectiveStack < 2 * view.bigBlind) return null;
  const solution = solvePushFold({ stackBB: effectiveStack / view.bigBlind });
  const bucket = bucketOfStrength(preflopStrength(view.self.holeCards), solution.boundaries);
  const selfIndex = view.players.findIndex((player) => player.id === view.viewerId);
  const isSmallBlind = selfIndex === view.buttonIndex;
  if (isSmallBlind) {
    const frequency = solution.sbPushFrequency[bucket];
    return {
      action: frequency >= 0.5 ? 'push' : 'fold',
      frequency: frequency >= 0.5 ? frequency : 1 - frequency,
      bucket,
      note: `GTO 短码（${(effectiveStack / view.bigBlind).toFixed(1)}BB 单挑）：桶 ${bucket}/9 全下频率 ${(frequency * 100).toFixed(0)}%`,
    };
  }
  const facingAllIn =
    view.legal?.isAllInCall === true ||
    (view.currentBet >= effectiveStack && view.currentBet > view.bigBlind);
  if (!facingAllIn) return null;
  const frequency = solution.bbCallFrequency[bucket];
  return {
    action: frequency >= 0.5 ? 'call' : 'fold',
    frequency: frequency >= 0.5 ? frequency : 1 - frequency,
    bucket,
    note: `GTO 短码（${(effectiveStack / view.bigBlind).toFixed(1)}BB 单挑）：桶 ${bucket}/9 跟注频率 ${(frequency * 100).toFixed(0)}%`,
  };
}

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
