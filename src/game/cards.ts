/**
 * 牌、牌堆、洗牌与可复现随机数。
 *
 * - 52 张牌，无大小王，花色不分大小。
 * - Fisher-Yates 洗牌；洗牌随机源为种子派生的 mulberry32 PRNG。
 * - 同一 seed + 手数 → 完全相同的牌堆（P1 可复现种子）。
 */
import type { Card, Rank, Suit } from './types';

export const SUITS: readonly Suit[] = ['s', 'h', 'd', 'c'];
export const RANKS: readonly Rank[] = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];

export const RANK_LABELS: Record<Rank, string> = {
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

export const SUIT_LABELS: Record<Suit, string> = { s: '♠', h: '♥', d: '♦', c: '♣' };
export const SUIT_NAMES: Record<Suit, string> = { s: '黑桃', h: '红桃', d: '方块', c: '梅花' };
export const SUIT_INDEX: Record<Suit, number> = { s: 0, h: 1, d: 2, c: 3 };

export function rankLabel(rank: Rank): string {
  return RANK_LABELS[rank];
}

export function cardLabel(card: Card): string {
  return `${RANK_LABELS[card.rank]}${SUIT_LABELS[card.suit]}`;
}

export function cardsLabel(cards: readonly Card[]): string {
  return cards.map(cardLabel).join(' ');
}

/** 生成 52 张牌，顺序固定（未洗牌）：按花色、点数排列。 */
export function createDeck(): Card[] {
  const deck: Card[] = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ rank, suit });
    }
  }
  return deck;
}

/** FNV-1a 32 位字符串哈希，用于把字符串种子转成数字种子。 */
export function hashString(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** mulberry32：小巧、快速的确定性 32 位 PRNG，返回 [0, 1)。 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededRng(seed: string | number): () => number {
  return mulberry32(typeof seed === 'string' ? hashString(seed) : seed >>> 0);
}

/** Fisher-Yates 洗牌，返回新数组，不修改输入。 */
export function shuffle<T>(items: readonly T[], rng: () => number): T[] {
  const result = items.slice();
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = result[i];
    result[i] = result[j];
    result[j] = tmp;
  }
  return result;
}

/** 第 handNo 手牌的洗好牌堆：由 seed + 手数确定，可复现。 */
export function buildShuffledDeck(seed: string, handNo: number): Card[] {
  const rng = mulberry32(hashString(`${seed}#hand-${handNo}`));
  return shuffle(createDeck(), rng);
}

/** 牌的稳定数字 id（0-51）：(rank-2)*4 + suitIndex。 */
export function cardId(card: Card): number {
  return (card.rank - 2) * 4 + SUIT_INDEX[card.suit];
}

export function cardFromId(id: number): Card {
  if (!Number.isInteger(id) || id < 0 || id > 51) {
    throw new Error(`非法牌 id：${id}`);
  }
  const rank = (Math.floor(id / 4) + 2) as Rank;
  const suit = SUITS[id % 4];
  return { rank, suit };
}

export function sameCard(a: Card, b: Card): boolean {
  return a.rank === b.rank && a.suit === b.suit;
}

/** 从牌堆中移除指定牌（用于测试 / 对手范围采样）。 */
export function removeCards(deck: readonly Card[], cards: readonly Card[]): Card[] {
  const used = new Set(cards.map(cardId));
  return deck.filter((card) => !used.has(cardId(card)));
}

/** 解析单张牌，如 "As" / "Td" / "10c"。仅测试与调试使用。 */
export function parseCard(text: string): Card {
  const match = /^(10|[2-9TJQKA])([shdc])$/i.exec(text.trim());
  if (!match) throw new Error(`无法解析牌：${text}`);
  const rankText = match[1].toUpperCase();
  const fixed: Record<string, Rank> = {
    '2': 2,
    '3': 3,
    '4': 4,
    '5': 5,
    '6': 6,
    '7': 7,
    '8': 8,
    '9': 9,
    '10': 10,
    T: 10,
    J: 11,
    Q: 12,
    K: 13,
    A: 14,
  };
  const suit = match[2].toLowerCase() as Suit;
  return { rank: fixed[rankText], suit };
}
