import { describe, expect, it } from 'vitest';
import {
  assignBotStyleIds,
  buildShuffledDeck,
  BOT_STYLE_COUNT,
  cardId,
  createDeck,
  derivedRng,
  seededRng,
  shuffle,
  xoshiro128ss,
} from '../game/cards';

describe('随机数：xoshiro128** 与种子派生', () => {
  it('同种子完全可复现，不同种子产生不同序列', () => {
    const a = xoshiro128ss(12345);
    const a2 = xoshiro128ss(12345);
    const b = xoshiro128ss(12346);
    const valuesA = Array.from({ length: 50 }, () => a());
    const valuesA2 = Array.from({ length: 50 }, () => a2());
    const valuesB = Array.from({ length: 50 }, () => b());
    expect(valuesA).toEqual(valuesA2);
    expect(valuesA).not.toEqual(valuesB);
  });

  it('输出在 [0,1) 内且有合理分散度', () => {
    const rng = seededRng('rng-quality');
    const buckets = new Array(10).fill(0);
    for (let i = 0; i < 10_000; i++) {
      const value = rng();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
      buckets[Math.floor(value * 10)] += 1;
    }
    // 每个十分位大约 1000 次；允许 20% 偏差
    for (const count of buckets) {
      expect(count).toBeGreaterThan(700);
      expect(count).toBeLessThan(1300);
    }
  });

  it('derivedRng：用途不同 → 随机流不同；用途相同 → 完全一致', () => {
    const a = derivedRng('hand-1', 2, 'style');
    const b = derivedRng('hand-1', 2, 'style');
    const c = derivedRng('hand-1', 2, 'other-purpose');
    const valuesA = Array.from({ length: 10 }, () => a());
    const valuesB = Array.from({ length: 10 }, () => b());
    const valuesC = Array.from({ length: 10 }, () => c());
    expect(valuesA).toEqual(valuesB);
    expect(valuesA).not.toEqual(valuesC);
  });

  it('洗牌结果确定、包含全部 52 张牌且同 seed 不同手数不同', () => {
    const first = buildShuffledDeck('shuffle-audit', 1).map(cardId);
    const firstAgain = buildShuffledDeck('shuffle-audit', 1).map(cardId);
    const secondHand = buildShuffledDeck('shuffle-audit', 2).map(cardId);
    const otherSeed = buildShuffledDeck('shuffle-audit-b', 1).map(cardId);
    expect(first).toEqual(firstAgain);
    expect(first).not.toEqual(secondHand);
    expect(first).not.toEqual(otherSeed);
    expect(new Set(first).size).toBe(52);
    expect([...first].sort((x, y) => x - y)).toEqual(createDeck().map(cardId).sort((x, y) => x - y));
  });

  it('洗牌统计均匀：1000 副牌中点数和花色分布接近理论值', () => {
    const decks = 1000;
    const rankCounts = new Array(13).fill(0);
    const suitCounts = new Array(4).fill(0);
    for (let deck = 0; deck < decks; deck++) {
      const cards = buildShuffledDeck(`stat-${deck}`, 1);
      for (const card of cards) {
        rankCounts[card.rank - 2] += 1;
        suitCounts[{ s: 0, h: 1, d: 2, c: 3 }[card.suit]] += 1;
      }
    }
    const expectedRank = (decks * 52) / 13;
    const rankChi = rankCounts.reduce((sum, count) => sum + ((count - expectedRank) ** 2) / expectedRank, 0);
    // 自由度 12；宽松阈值（远低于随机异常值）
    expect(rankChi).toBeLessThan(40);
    const expectedSuit = (decks * 52) / 4;
    const suitChi = suitCounts.reduce((sum, count) => sum + ((count - expectedSuit) ** 2) / expectedSuit, 0);
    expect(suitChi).toBeLessThan(20);
  });

  it('风格分配：确定性、同桌尽量不重复、换种子会换组合', () => {
    const players = [1, 2, 3, 4, 5];
    const a = assignBotStyleIds('style-seed-a', players);
    const a2 = assignBotStyleIds('style-seed-a', players);
    const b = assignBotStyleIds('style-seed-b', players);
    expect([...a.entries()]).toEqual([...a2.entries()]);
    const styles = [...a.values()];
    expect(new Set(styles).size).toBe(players.length);
    for (const style of styles) {
      expect(style).toBeGreaterThanOrEqual(0);
      expect(style).toBeLessThan(BOT_STYLE_COUNT);
    }
    expect([...b.values()]).not.toEqual(styles);
  });

  it('shuffle 不修改输入数组', () => {
    const input = createDeck();
    const snapshot = input.map(cardId);
    shuffle(input, seededRng('no-mutate'));
    expect(input.map(cardId)).toEqual(snapshot);
  });
});
