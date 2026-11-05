/**
 * 牌型求值：5-7 张牌中选出最强的 5 张。
 *
 * 牌型大小（从大到小）：
 * 皇家同花顺 > 同花顺 > 四条 > 葫芦 > 同花 > 顺子 > 三条 > 两对 > 一对 > 高牌
 *
 * 关键规则：
 * - 52 张牌、4 花色不分大小、7 选 5。
 * - A 可作最大，也可作最小组成 A-2-3-4-5；禁止 Q-K-A-2-3。
 * - 同牌型先比主牌点，再比踢脚；完全平局返回相同 score。
 *
 * score 为整数，可直接用 >、<、=== 比较强弱。
 */
import type { Card, Rank } from './types';
import { RANK_LABELS, cardId } from './cards';

export const HAND_CATEGORY = {
  HIGH_CARD: 0,
  PAIR: 1,
  TWO_PAIR: 2,
  TRIPS: 3,
  STRAIGHT: 4,
  FLUSH: 5,
  FULL_HOUSE: 6,
  QUADS: 7,
  STRAIGHT_FLUSH: 8,
} as const;

export type HandCategory = (typeof HAND_CATEGORY)[keyof typeof HAND_CATEGORY];

export const CATEGORY_NAMES: Record<HandCategory, string> = {
  0: '高牌',
  1: '一对',
  2: '两对',
  3: '三条',
  4: '顺子',
  5: '同花',
  6: '葫芦',
  7: '四条',
  8: '同花顺',
};

export interface EvaluatedHand {
  category: HandCategory;
  /** 中文牌型名；皇家同花顺会单独命名。 */
  categoryName: string;
  /** 比较用的点数列（从主到次，不含补 0），如一对 = [对子点, 踢脚1, 踢脚2, 踢脚3]。 */
  kickers: number[];
  /** 可直接比较的整数分值，越大越强。 */
  score: number;
  isRoyal: boolean;
}

const SCORE_BASE = 16;
const CATEGORY_FACTOR = SCORE_BASE ** 5;
const ACE_LOW_BIT = 1 << 1;

/** 预计算顺子表：mask（bit2..bit14 表示各点数）→ 最大顺子高牌，0 表示无顺子。 */
const STRAIGHT_HIGH_TABLE: Uint8Array = (() => {
  const table = new Uint8Array(1 << 15);
  for (let mask = 0; mask < 1 << 15; mask++) {
    let m = mask;
    // A 可作 1：有 A 时同时尝试低位。
    if (mask & (1 << 14)) m |= ACE_LOW_BIT;
    let high = 0;
    for (let h = 14; h >= 5; h--) {
      const need = 0b11111 << (h - 4);
      if ((m & need) === need) {
        high = h;
        break;
      }
    }
    table[mask] = high;
  }
  return table;
})();

function straightHigh(mask: number): number {
  return STRAIGHT_HIGH_TABLE[mask & 0x7fff];
}

function makeHand(category: HandCategory, ranks: number[]): EvaluatedHand {
  let score = category * CATEGORY_FACTOR;
  let unit = CATEGORY_FACTOR / SCORE_BASE; // 16^4
  for (let i = 0; i < 5; i++) {
    score += (ranks[i] ?? 0) * unit;
    unit /= SCORE_BASE;
  }
  const isRoyal = category === HAND_CATEGORY.STRAIGHT_FLUSH && ranks[0] === 14;
  return {
    category,
    categoryName: isRoyal ? '皇家同花顺' : CATEGORY_NAMES[category],
    kickers: ranks.slice(),
    score,
    isRoyal,
  };
}

/** 从 count 表中取最大的若干点数，排除 exclude 中的点数。 */
function topRanks(rankCount: Int8Array, exclude: readonly number[], count: number): number[] {
  const result: number[] = [];
  for (let r = 14; r >= 2 && result.length < count; r--) {
    if (rankCount[r] > 0 && !exclude.includes(r)) result.push(r);
  }
  return result;
}

/** 从 rank bit mask 中取最大的若干点数。 */
function topRanksFromMask(mask: number, count: number): number[] {
  const result: number[] = [];
  for (let r = 14; r >= 2 && result.length < count; r--) {
    if (mask & (1 << r)) result.push(r);
  }
  return result;
}

/**
 * 求值 5-7 张牌中的最佳 5 张牌型。
 * @throws 牌数不是 5-7 张，或存在重复牌时抛错。
 */
export function evaluate(cards: readonly Card[]): EvaluatedHand {
  if (cards.length < 5 || cards.length > 7) {
    throw new Error(`牌型求值需要 5-7 张牌，实际收到 ${cards.length} 张`);
  }
  const seen = new Set<number>();
  for (const card of cards) {
    const id = cardId(card);
    if (seen.has(id)) throw new Error(`存在重复牌：${card.rank}${card.suit}`);
    seen.add(id);
  }

  const rankCount = new Int8Array(15);
  const suitCount = [0, 0, 0, 0];
  const suitRankMask = [0, 0, 0, 0];
  let rankMask = 0;

  for (const card of cards) {
    rankCount[card.rank]++;
    const suitIndex = card.suit === 's' ? 0 : card.suit === 'h' ? 1 : card.suit === 'd' ? 2 : 3;
    suitCount[suitIndex]++;
    suitRankMask[suitIndex] |= 1 << card.rank;
    rankMask |= 1 << card.rank;
  }

  // 1) 同花顺 / 皇家同花顺
  let flushSuit = -1;
  for (let s = 0; s < 4; s++) {
    if (suitCount[s] >= 5) flushSuit = s;
  }
  if (flushSuit >= 0) {
    const sfHigh = straightHigh(suitRankMask[flushSuit]);
    if (sfHigh > 0) return makeHand(HAND_CATEGORY.STRAIGHT_FLUSH, [sfHigh]);
  }

  // 2) 四条
  for (let r = 14; r >= 2; r--) {
    if (rankCount[r] === 4) {
      return makeHand(HAND_CATEGORY.QUADS, [r, ...topRanks(rankCount, [r], 1)]);
    }
  }

  // 三条 / 对子统计（四条已排除）
  const trips: number[] = [];
  const pairs: number[] = [];
  for (let r = 14; r >= 2; r--) {
    if (rankCount[r] >= 3) trips.push(r);
    else if (rankCount[r] === 2) pairs.push(r);
  }

  // 3) 葫芦
  if (trips.length >= 1) {
    if (trips.length >= 2) return makeHand(HAND_CATEGORY.FULL_HOUSE, [trips[0], trips[1]]);
    if (pairs.length >= 1) return makeHand(HAND_CATEGORY.FULL_HOUSE, [trips[0], pairs[0]]);
  }

  // 4) 同花
  if (flushSuit >= 0) {
    return makeHand(HAND_CATEGORY.FLUSH, topRanksFromMask(suitRankMask[flushSuit], 5));
  }

  // 5) 顺子
  const straight = straightHigh(rankMask);
  if (straight > 0) return makeHand(HAND_CATEGORY.STRAIGHT, [straight]);

  // 6) 三条
  if (trips.length >= 1) {
    return makeHand(HAND_CATEGORY.TRIPS, [trips[0], ...topRanks(rankCount, [trips[0]], 2)]);
  }

  // 7) 两对
  if (pairs.length >= 2) {
    const [first, second] = [pairs[0], pairs[1]];
    return makeHand(HAND_CATEGORY.TWO_PAIR, [
      first,
      second,
      ...topRanks(rankCount, [first, second], 1),
    ]);
  }

  // 8) 一对
  if (pairs.length === 1) {
    return makeHand(HAND_CATEGORY.PAIR, [pairs[0], ...topRanks(rankCount, [pairs[0]], 3)]);
  }

  // 9) 高牌
  return makeHand(HAND_CATEGORY.HIGH_CARD, topRanks(rankCount, [], 5));
}

/** 只有 5 张牌时的求值（语义别名）。 */
export function evaluate5(cards: readonly Card[]): EvaluatedHand {
  if (cards.length !== 5) throw new Error(`evaluate5 需要 5 张牌，实际收到 ${cards.length} 张`);
  return evaluate(cards);
}

/** 7 张牌求值（语义别名）。 */
export function evaluate7(cards: readonly Card[]): EvaluatedHand {
  if (cards.length !== 7) throw new Error(`evaluate7 需要 7 张牌，实际收到 ${cards.length} 张`);
  return evaluate(cards);
}

/** 从 5-7 张牌中选出真正组成最佳牌型的 5 张（用于摊牌高亮）。 */
export function bestFive(cards: readonly Card[]): { hand: EvaluatedHand; cards: Card[] } {
  if (cards.length < 5 || cards.length > 7) {
    throw new Error(`bestFive 需要 5-7 张牌，实际收到 ${cards.length} 张`);
  }
  if (cards.length === 5) {
    return { hand: evaluate(cards), cards: cards.slice() };
  }
  let best: { hand: EvaluatedHand; cards: Card[] } | null = null;
  const n = cards.length;
  for (let a = 0; a < n - 4; a++) {
    for (let b = a + 1; b < n - 3; b++) {
      for (let c = b + 1; c < n - 2; c++) {
        for (let d = c + 1; d < n - 1; d++) {
          for (let e = d + 1; e < n; e++) {
            const combo = [cards[a], cards[b], cards[c], cards[d], cards[e]];
            const hand = evaluate(combo);
            if (best === null || hand.score > best.hand.score) {
              best = { hand, cards: combo };
            }
          }
        }
      }
    }
  }
  return best as { hand: EvaluatedHand; cards: Card[] };
}

/** 比较两手牌：>0 表示 a 更强，<0 表示 b 更强，0 表示完全平局。 */
export function compareHands(a: EvaluatedHand, b: EvaluatedHand): number {
  return a.score - b.score;
}

const RANK_CN: Record<number, string> = {
  2: '2',
  3: '3',
  4: '4',
  5: '5',
  6: '6',
  7: '7',
  8: '8',
  9: '9',
  10: '10',
  11: 'J',
  12: 'Q',
  13: 'K',
  14: 'A',
};

function label(rank: number): string {
  return RANK_CN[rank] ?? String(rank);
}

/** 牌型的可读中文描述，用于日志与摊牌展示。 */
export function describeHand(hand: EvaluatedHand): string {
  const k = hand.kickers;
  switch (hand.category) {
    case HAND_CATEGORY.STRAIGHT_FLUSH:
      return hand.isRoyal ? '皇家同花顺' : `同花顺（${label(k[0])} 高）`;
    case HAND_CATEGORY.QUADS:
      return `四条（${label(k[0])}）`;
    case HAND_CATEGORY.FULL_HOUSE:
      return `葫芦（${label(k[0])} 带 ${label(k[1])}）`;
    case HAND_CATEGORY.FLUSH:
      return `同花（${label(k[0])} 高）`;
    case HAND_CATEGORY.STRAIGHT:
      return `顺子（${label(k[0])} 高）`;
    case HAND_CATEGORY.TRIPS:
      return `三条（${label(k[0])}）`;
    case HAND_CATEGORY.TWO_PAIR:
      return `两对（${label(k[0])} 与 ${label(k[1])}）`;
    case HAND_CATEGORY.PAIR:
      return `一对（${label(k[0])}）`;
    case HAND_CATEGORY.HIGH_CARD:
      return `高牌（${label(k[0])} 高）`;
    default:
      return CATEGORY_NAMES[hand.category];
  }
}

/** 判断点数组是否构成顺子（含 A-2-3-4-5），返回顺子高牌或 0。仅用于测试辅助。 */
export function detectStraightHigh(ranks: readonly Rank[]): number {
  let mask = 0;
  for (const r of ranks) mask |= 1 << r;
  return straightHigh(mask);
}
