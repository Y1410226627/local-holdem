import { describe, expect, it } from 'vitest';
import {
  buildShuffledDeck,
  cardFromId,
  cardId,
  cardLabel,
  cardsLabel,
  createDeck,
  hashString,
  mulberry32,
  parseCard,
  seededRng,
  shuffle,
} from '../game/cards';
import { C, CC } from './helpers';

describe('牌与牌堆', () => {
  it('一副牌 52 张且互不重复', () => {
    const deck = createDeck();
    expect(deck).toHaveLength(52);
    expect(new Set(deck.map(cardId)).size).toBe(52);
  });

  it('每个点数 4 张、每个花色 13 张', () => {
    const deck = createDeck();
    for (let rank = 2; rank <= 14; rank++) {
      expect(deck.filter((card) => card.rank === rank)).toHaveLength(4);
    }
    for (const suit of ['s', 'h', 'd', 'c']) {
      expect(deck.filter((card) => card.suit === suit)).toHaveLength(13);
    }
  });

  it('cardId 与 cardFromId 可逆', () => {
    for (let id = 0; id < 52; id++) {
      expect(cardId(cardFromId(id))).toBe(id);
    }
  });

  it('牌面文本格式', () => {
    expect(cardLabel(C('As'))).toBe('A♠');
    expect(cardLabel(C('Td'))).toBe('10♦');
    expect(cardsLabel(CC('Ah Kd 2c'))).toBe('A♥ K♦ 2♣');
  });

  it('parseCard 解析各种写法', () => {
    expect(parseCard('as')).toEqual({ rank: 14, suit: 's' });
    expect(parseCard('10h')).toEqual({ rank: 10, suit: 'h' });
    expect(parseCard('Jc')).toEqual({ rank: 11, suit: 'c' });
    expect(() => parseCard('1x')).toThrow();
  });
});

describe('洗牌与可复现随机', () => {
  it('Fisher-Yates 洗牌不修改输入', () => {
    const input = createDeck();
    const snapshot = input.map(cardId);
    shuffle(input, mulberry32(42));
    expect(input.map(cardId)).toEqual(snapshot);
  });

  it('相同 seed + 手数 → 相同牌堆', () => {
    const a = buildShuffledDeck('seed-abc', 7).map(cardId);
    const b = buildShuffledDeck('seed-abc', 7).map(cardId);
    expect(a).toEqual(b);
  });

  it('不同 seed 或手数 → 不同牌堆', () => {
    const base = buildShuffledDeck('seed-abc', 1).map(cardId);
    expect(buildShuffledDeck('seed-abd', 1).map(cardId)).not.toEqual(base);
    expect(buildShuffledDeck('seed-abc', 2).map(cardId)).not.toEqual(base);
  });

  it('洗牌结果是 52 张的排列', () => {
    const deck = buildShuffledDeck('perm', 3);
    expect(deck).toHaveLength(52);
    expect(new Set(deck.map(cardId)).size).toBe(52);
  });

  it('mulberry32 输出在 [0,1) 且可复现', () => {
    const a = mulberry32(123);
    const b = mulberry32(123);
    for (let i = 0; i < 1000; i++) {
      const value = a();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
      expect(value).toBe(b());
    }
  });

  it('字符串 seed 可转数字且稳定', () => {
    expect(hashString('abc')).toBe(hashString('abc'));
    expect(hashString('abc')).not.toBe(hashString('abd'));
    const rngA = seededRng('hello');
    const rngB = seededRng('hello');
    expect(rngA()).toBe(rngB());
  });
});
