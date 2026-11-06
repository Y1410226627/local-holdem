/**
 * 求解器公共底座：组合、真实胜率桶、牌面纹理、摊牌比较。
 *
 * 设计约束（安全官要求）：
 * - 本模块只接收 Card[] 与公开牌面，不接收 HandState / deck / 对手底牌。
 * - 所有随机性由调用方传入的 rng 提供，模块内部不使用 Math.random。
 */
import type { Card } from '../../game/types';
import { createDeck } from '../../game/cards';
import { compareHands, evaluate7 } from '../../game/handEvaluator';
import { analyzePostflop, handKey } from '../rangeModel';
import equityRaw from '../data/preflop-equity.json';

export interface Combo {
  first: Card;
  second: Card;
  key: string;
}

export interface PreflopEquityTable {
  entries: Record<string, { equity: number; combos: number; chen: number }>;
}

const EQUITY_TABLE = equityRaw as unknown as PreflopEquityTable;

export const PREFLOP_BUCKETS = 10;

export function cardKey(card: Card): string {
  return `${card.rank}${card.suit}`;
}

/** 规范组合键：大牌在前；同 rank 时按花色排序，保证可逆。 */
export function comboKey(first: Card, second: Card): string {
  const a = cardKey(first);
  const b = cardKey(second);
  return a <= b ? `${a}|${b}` : `${b}|${a}`;
}

export function parseComboKey(key: string): [Card, Card] {
  const [a, b] = key.split('|');
  const parse = (text: string): Card => {
    const suit = text[text.length - 1] as Card['suit'];
    const rank = Number(text.slice(0, -1)) as Card['rank'];
    return { rank, suit };
  };
  return [parse(a), parse(b)];
}

export function comboOf(first: Card, second: Card): Combo {
  return { first, second, key: comboKey(first, second) };
}

/** 枚举所有未与 dead 冲突的组合。 */
export function allCombos(dead: ReadonlySet<string> = new Set()): Combo[] {
  const deck = createDeck().filter((card) => !dead.has(cardKey(card)));
  const out: Combo[] = [];
  for (let i = 0; i < deck.length; i++) {
    for (let j = i + 1; j < deck.length; j++) {
      out.push(comboOf(deck[i], deck[j]));
    }
  }
  return out;
}

/** 169 类起手牌的真实胜率（对随机手牌）。 */
export function preflopEquityOf(first: Card, second: Card): number {
  return EQUITY_TABLE.entries[handKey([first, second])]?.equity ?? 0.5;
}

export function preflopEquityOfKey(key: string): number {
  return EQUITY_TABLE.entries[key]?.equity ?? 0.5;
}

export function preflopClassWeight(key: string): number {
  return EQUITY_TABLE.entries[key]?.combos ?? 6;
}

interface BucketTable {
  /** 桶 id 0..9，按真实胜率从弱到强。 */
  bucketOfClass: Map<string, number>;
  /** 每个桶的类别键（按胜率升序）。 */
  classesOfBucket: string[][];
  /** 每个桶的胜率下界。 */
  boundaries: number[];
  /** 每个桶的代表类别（中位胜率）。 */
  reps: string[];
}

let bucketCache: BucketTable | null = null;

/**
 * 按真实胜率 + 组合质量把 169 类分成 10 个桶。
 * 与旧实现的区别：不再用 Chen 分数排序，桶内代表牌取中位胜率的真实类别。
 */
export function preflopBucketTable(): BucketTable {
  if (bucketCache) return bucketCache;
  const keys = Object.keys(EQUITY_TABLE.entries);
  const sorted = keys
    .map((key) => ({ key, equity: preflopEquityOfKey(key), weight: preflopClassWeight(key) }))
    .sort((a, b) => a.equity - b.equity);
  const totalWeight = sorted.reduce((sum, item) => sum + item.weight, 0);
  const target = totalWeight / PREFLOP_BUCKETS;
  const classesOfBucket: string[][] = Array.from({ length: PREFLOP_BUCKETS }, () => []);
  const bucketOfClass = new Map<string, number>();
  let bucket = 0;
  let mass = 0;
  for (const item of sorted) {
    // 当前桶已过半且还有下一个桶时，进入下一个桶（保证弱牌不会被硬塞进强桶）。
    if (mass >= target && bucket < PREFLOP_BUCKETS - 1) {
      bucket += 1;
      mass = 0;
    }
    classesOfBucket[bucket].push(item.key);
    bucketOfClass.set(item.key, bucket);
    mass += item.weight;
  }
  const boundaries: number[] = [];
  const reps: string[] = [];
  for (let b = 0; b < PREFLOP_BUCKETS; b++) {
    const list = classesOfBucket[b];
    if (list.length === 0) {
      boundaries.push(1);
      reps.push('72o');
      continue;
    }
    boundaries.push(preflopEquityOfKey(list[0]));
    reps.push(list[Math.floor(list.length / 2)]);
  }
  bucketCache = { bucketOfClass, classesOfBucket, boundaries, reps };
  return bucketCache;
}

export function bucketOfCards(first: Card, second: Card): number {
  const key = handKey([first, second]);
  return preflopBucketTable().bucketOfClass.get(key) ?? 0;
}

/** 桶的强度中位数（0..1），供范围/赔率计算使用。 */
export function bucketStrength(bucket: number): number {
  const table = preflopBucketTable();
  const list = table.classesOfBucket[Math.max(0, Math.min(PREFLOP_BUCKETS - 1, bucket))] ?? [];
  if (list.length === 0) return 0.5;
  return preflopEquityOfKey(list[Math.floor(list.length / 2)]);
}

export interface BoardTexture {
  paired: boolean;
  trips: boolean;
  monotone: boolean;
  twoTone: boolean;
  flushPossible: boolean;
  straightPossible: boolean;
  connected: boolean;
  /** 0..1，越大越湿（听牌多 / 关联强）。 */
  wetness: number;
  highCard: number;
}

/** 公共牌纹理：只依赖公共牌，不依赖任何底牌。 */
export function boardTexture(board: readonly Card[]): BoardTexture {
  const rankCount = new Map<number, number>();
  const suitCount = new Map<string, number>();
  for (const card of board) {
    rankCount.set(card.rank, (rankCount.get(card.rank) ?? 0) + 1);
    suitCount.set(card.suit, (suitCount.get(card.suit) ?? 0) + 1);
  }
  const maxRankCount = Math.max(0, ...rankCount.values());
  const maxSuitCount = Math.max(0, ...suitCount.values());
  const ranks = [...rankCount.keys()].sort((a, b) => b - a);
  let connected = false;
  let straightPossible = false;
  for (let i = 0; i < ranks.length; i++) {
    for (let j = i + 1; j < ranks.length; j++) {
      if (Math.abs(ranks[i] - ranks[j]) <= 2) connected = true;
    }
  }
  // 三张以上、跨度 <= 4 的牌面视为顺子听牌可能。
  if (ranks.length >= 3 && ranks[0] - ranks[ranks.length - 1] <= 4) straightPossible = true;
  const paired = maxRankCount >= 2;
  const trips = maxRankCount >= 3;
  const monotone = maxSuitCount >= 3;
  const twoTone = maxSuitCount === 2;
  const flushPossible = maxSuitCount >= 3;
  const wetness = Math.min(
    1,
    (flushPossible ? 0.35 : 0) +
      (straightPossible ? 0.3 : 0) +
      (connected ? 0.15 : 0) +
      (paired ? 0.1 : 0) +
      (trips ? 0.1 : 0),
  );
  return {
    paired,
    trips,
    monotone,
    twoTone,
    flushPossible,
    straightPossible,
    connected,
    wetness,
    highCard: ranks[0] ?? 0,
  };
}

/** 单手牌在牌面上的 0..1 强度（含听牌）。翻前用真实胜率。 */
export function comboStrength(hole: readonly Card[], board: readonly Card[]): number {
  if (board.length < 3) {
    return preflopEquityOf(hole[0], hole[1]);
  }
  return analyzePostflop(hole, board).strength;
}

/** 是否含听牌（用于范围似然的下注/半诈唬加成）。 */
export function comboHasDraw(hole: readonly Card[], board: readonly Card[]): boolean {
  if (board.length < 3) return false;
  return analyzePostflop(hole, board).draw.hasDraw;
}

/** 摊牌符号：1 我方赢，-1 输，0 平。 */
export function showdownSign(
  hero: readonly [Card, Card],
  villain: readonly [Card, Card],
  board: readonly Card[],
): number {
  if (board.length < 5) return 0;
  const result = compareHands(
    evaluate7([hero[0], hero[1], ...board]),
    evaluate7([villain[0], villain[1], ...board]),
  );
  return result > 0 ? 1 : result < 0 ? -1 : 0;
}

/** 按权重不放回抽样（用于把 1326 组合压缩到 120 个求解组合）。 */
export function weightedSample<T>(
  items: readonly T[],
  weights: readonly number[],
  count: number,
  rng: () => number,
): T[] {
  const pool = items.map((item, index) => ({ item, weight: Math.max(1e-6, weights[index] ?? 1) }));
  const out: T[] = [];
  const target = Math.min(count, pool.length);
  for (let i = 0; i < target; i++) {
    const total = pool.reduce((sum, entry) => sum + entry.weight, 0);
    if (total <= 0) break;
    let roll = rng() * total;
    let picked = 0;
    for (let j = 0; j < pool.length; j++) {
      roll -= pool[j].weight;
      if (roll <= 0) {
        picked = j;
        break;
      }
      picked = j;
    }
    out.push(pool[picked].item);
    pool.splice(picked, 1);
  }
  return out;
}
