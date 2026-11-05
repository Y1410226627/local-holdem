import { describe, expect, it } from 'vitest';
import {
  CATEGORY_NAMES,
  HAND_CATEGORY,
  bestFive,
  compareHands,
  describeHand,
  detectStraightHigh,
  evaluate,
  evaluate5,
  evaluate7,
} from '../game/handEvaluator';
import { buildShuffledDeck, cardLabel } from '../game/cards';
import type { Card, Rank } from '../game/types';
import { C, CC } from './helpers';

function combos5(cards: Card[]): Card[][] {
  const result: Card[][] = [];
  const n = cards.length;
  for (let a = 0; a < n - 4; a++)
    for (let b = a + 1; b < n - 3; b++)
      for (let c = b + 1; c < n - 2; c++)
        for (let d = c + 1; d < n - 1; d++)
          for (let e = d + 1; e < n; e++) {
            result.push([cards[a], cards[b], cards[c], cards[d], cards[e]]);
          }
  return result;
}

describe('牌型识别：10 种牌型', () => {
  it('皇家同花顺', () => {
    const hand = evaluate(CC('As Ks Qs Js Ts 2h 3d'));
    expect(hand.category).toBe(HAND_CATEGORY.STRAIGHT_FLUSH);
    expect(hand.isRoyal).toBe(true);
    expect(hand.categoryName).toBe('皇家同花顺');
    expect(hand.kickers[0]).toBe(14);
  });

  it('同花顺（9 高）', () => {
    const hand = evaluate(CC('9h 8h 7h 6h 5h Ad Kc'));
    expect(hand.category).toBe(HAND_CATEGORY.STRAIGHT_FLUSH);
    expect(hand.isRoyal).toBe(false);
    expect(hand.kickers[0]).toBe(9);
  });

  it('四条，带最大踢脚', () => {
    const hand = evaluate(CC('7s 7h 7d 7c As 2h 3d'));
    expect(hand.category).toBe(HAND_CATEGORY.QUADS);
    expect(hand.kickers).toEqual([7, 14]);
  });

  it('葫芦，三条优先于对子', () => {
    const hand = evaluate(CC('8s 8h 8d Ks Kh 2c 3d'));
    expect(hand.category).toBe(HAND_CATEGORY.FULL_HOUSE);
    expect(hand.kickers).toEqual([8, 13]);
  });

  it('葫芦：两条三条时取较大的三条', () => {
    const hand = evaluate(CC('As Ah Ad Ks Kh Kd 2c'));
    expect(hand.category).toBe(HAND_CATEGORY.FULL_HOUSE);
    expect(hand.kickers).toEqual([14, 13]);
  });

  it('同花，按最大五张比较', () => {
    const hand = evaluate(CC('As Js 9s 6s 3s 2h 4d'));
    expect(hand.category).toBe(HAND_CATEGORY.FLUSH);
    expect(hand.kickers).toEqual([14, 11, 9, 6, 3]);
  });

  it('顺子（9 高）', () => {
    const hand = evaluate(CC('9s 8h 7d 6c 5s As 2d'));
    expect(hand.category).toBe(HAND_CATEGORY.STRAIGHT);
    expect(hand.kickers).toEqual([9]);
  });

  it('A-2-3-4-5 是顺子，A 作最小', () => {
    const hand = evaluate(CC('Ad 2h 3s 4c 5d Kh Qs'));
    expect(hand.category).toBe(HAND_CATEGORY.STRAIGHT);
    expect(hand.kickers).toEqual([5]);
    expect(detectStraightHigh([14, 2, 3, 4, 5] as Rank[])).toBe(5);
  });

  it('禁止 Q-K-A-2-3 顺子', () => {
    const hand = evaluate(CC('Qd Kh As 2c 3s 7h 8d'));
    expect(hand.category).toBe(HAND_CATEGORY.HIGH_CARD);
    expect(detectStraightHigh([12, 13, 14, 2, 3] as Rank[])).toBe(0);
  });

  it('三条，比较两个踢脚', () => {
    const hand = evaluate(CC('Qs Qh Qd 9s 5c 2h 3d'));
    expect(hand.category).toBe(HAND_CATEGORY.TRIPS);
    expect(hand.kickers).toEqual([12, 9, 5]);
  });

  it('两对，比较踢脚', () => {
    const hand = evaluate(CC('Qs Qh 9d 9c As 2h 3d'));
    expect(hand.category).toBe(HAND_CATEGORY.TWO_PAIR);
    expect(hand.kickers).toEqual([12, 9, 14]);
  });

  it('一对，比较三个踢脚', () => {
    const hand = evaluate(CC('Qs Qh 9d 7c 5s 2h 3d'));
    expect(hand.category).toBe(HAND_CATEGORY.PAIR);
    expect(hand.kickers).toEqual([12, 9, 7, 5]);
  });

  it('高牌，取最大五张', () => {
    const hand = evaluate(CC('As Qh 9d 7c 5s 2h 3d'));
    expect(hand.category).toBe(HAND_CATEGORY.HIGH_CARD);
    expect(hand.kickers).toEqual([14, 12, 9, 7, 5]);
  });

  it('所有牌型名称齐全', () => {
    expect(CATEGORY_NAMES[HAND_CATEGORY.HIGH_CARD]).toBe('高牌');
    expect(CATEGORY_NAMES[HAND_CATEGORY.PAIR]).toBe('一对');
    expect(CATEGORY_NAMES[HAND_CATEGORY.TWO_PAIR]).toBe('两对');
    expect(CATEGORY_NAMES[HAND_CATEGORY.TRIPS]).toBe('三条');
    expect(CATEGORY_NAMES[HAND_CATEGORY.STRAIGHT]).toBe('顺子');
    expect(CATEGORY_NAMES[HAND_CATEGORY.FLUSH]).toBe('同花');
    expect(CATEGORY_NAMES[HAND_CATEGORY.FULL_HOUSE]).toBe('葫芦');
    expect(CATEGORY_NAMES[HAND_CATEGORY.QUADS]).toBe('四条');
    expect(CATEGORY_NAMES[HAND_CATEGORY.STRAIGHT_FLUSH]).toBe('同花顺');
  });
});

describe('牌型比较与踢脚', () => {
  it('同为一对 K：A 踢脚 > Q 踢脚', () => {
    const withAce = evaluate(CC('Kh Kd As 7c 5s 3h 2d'));
    const withQueen = evaluate(CC('Ks Kc Qs 7d 5h 3c 2s'));
    expect(compareHands(withAce, withQueen)).toBeGreaterThan(0);
  });

  it('两对比较：先比大对，再比小对，再比踢脚', () => {
    const big = evaluate(CC('Ah Ad Ks Kd 9c 3h 2s'));
    const small = evaluate(CC('As Ac Qs Qd Jc 3h 2s'));
    expect(compareHands(big, small)).toBeGreaterThan(0);
  });

  it('完全相同牌力（不同花色）平局', () => {
    const a = CC('Ah Kd Qs Jc 9h 2s 3d');
    const b = CC('As Kh Qd Js 9c 2d 3h');
    expect(compareHands(evaluate(a), evaluate(b))).toBe(0);
    expect(evaluate(a).score).toBe(evaluate(b).score);
  });

  it('A-2-3-4-5 顺子小于 2-3-4-5-6 顺子', () => {
    const wheel = evaluate(CC('Ad 2h 3s 4c 5d Kh Qs'));
    const sixHigh = evaluate(CC('2d 3h 4s 5c 6d Kh Qs'));
    expect(compareHands(wheel, sixHigh)).toBeLessThan(0);
  });

  it('牌型等级严格递减', () => {
    const hands = [
      evaluate(CC('As Ks Qs Js Ts 2h 3d')), // 皇家同花顺
      evaluate(CC('9h 8h 7h 6h 5h Ad Kc')), // 同花顺
      evaluate(CC('7s 7h 7d 7c As 2h 3d')), // 四条
      evaluate(CC('8s 8h 8d Ks Kh 2c 3d')), // 葫芦
      evaluate(CC('As Js 9s 6s 3s 2h 4d')), // 同花
      evaluate(CC('9s 8h 7d 6c 5s As 2d')), // 顺子
      evaluate(CC('Qs Qh Qd 9s 5c 2h 3d')), // 三条
      evaluate(CC('Qs Qh 9d 9c As 2h 3d')), // 两对
      evaluate(CC('Qs Qh 9d 7c 5s 2h 3d')), // 一对
      evaluate(CC('As Qh 9d 7c 5s 2h 3d')), // 高牌
    ];
    for (let i = 1; i < hands.length; i++) {
      expect(hands[i - 1].score).toBeGreaterThan(hands[i].score);
      expect(compareHands(hands[i - 1], hands[i])).toBeGreaterThan(0);
    }
  });

  it('同花同时存在顺子时取同花', () => {
    const hand = evaluate(CC('As Ks 5s 4s 3s 6h 7d'));
    expect(hand.category).toBe(HAND_CATEGORY.FLUSH);
  });

  it('葫芦大于同花', () => {
    const fullHouse = evaluate(CC('5s 5h 5d 2s 2h 8d 9c'));
    const flush = evaluate(CC('As Js 9s 6s 3s 2h 4d'));
    expect(compareHands(fullHouse, flush)).toBeGreaterThan(0);
  });
});

describe('7 选 5 与 bestFive', () => {
  it('7 张牌中选出同花的最佳 5 张', () => {
    const cards = CC('As Ks Qs Js 9s 2h 3d');
    const { hand, cards: best } = bestFive(cards);
    expect(hand.category).toBe(HAND_CATEGORY.FLUSH);
    expect(best).toHaveLength(5);
    expect(best.every((card) => card.suit === 's')).toBe(true);
    expect(hand.score).toBe(evaluate7(cards).score);
  });

  it('7 张牌中选出顺子的最佳 5 张', () => {
    const cards = CC('2h 3d 4s 5c 6h Ac Kd');
    const { hand, cards: best } = bestFive(cards);
    expect(hand.category).toBe(HAND_CATEGORY.STRAIGHT);
    expect(hand.kickers[0]).toBe(6);
    expect(best.map(cardLabel).sort()).toEqual(['2♥', '3♦', '4♠', '5♣', '6♥']);
  });

  it('7 张牌同时有两对与三条时取葫芦', () => {
    const cards = CC('9s 9h 9d 5c 5s Ad Kd');
    const { hand } = bestFive(cards);
    expect(hand.category).toBe(HAND_CATEGORY.FULL_HOUSE);
  });

  it('bestFive 的牌型与 evaluate 的牌型一致（随机 300 组）', () => {
    for (let hand = 0; hand < 300; hand++) {
      const deck = buildShuffledDeck(`best-five-${hand}`, hand + 1);
      const cards = deck.slice(0, 7);
      const fast = evaluate(cards);
      const { hand: best } = bestFive(cards);
      expect(best.score).toBe(fast.score);
      expect(best.category).toBe(fast.category);
    }
  });

  it('evaluate 与暴力枚举 21 种 5 张组合结果一致（随机 300 组）', () => {
    for (let hand = 0; hand < 300; hand++) {
      const deck = buildShuffledDeck(`brute-${hand}`, hand + 1);
      const cards = deck.slice(0, 7);
      let bestScore = -1;
      for (const combo of combos5(cards)) {
        bestScore = Math.max(bestScore, evaluate5(combo).score);
      }
      expect(evaluate7(cards).score).toBe(bestScore);
    }
  });

  it('evaluate5 与 evaluate7 的参数校验', () => {
    expect(() => evaluate5(CC('As Ks Qs Js'))).toThrow();
    expect(() => evaluate7(CC('As Ks Qs Js Ts 2h'))).toThrow();
    expect(() => evaluate(CC('As Ks Qs Js Ts 2h 3d 4c'))).toThrow();
  });

  it('重复牌抛错', () => {
    expect(() => evaluate(CC('As As Qs Js Ts 2h 3d'))).toThrow(/重复/);
  });
});

describe('牌型中文描述', () => {
  it('描述包含牌型与关键点数', () => {
    expect(describeHand(evaluate(CC('As Ks Qs Js Ts 2h 3d')))).toBe('皇家同花顺');
    expect(describeHand(evaluate(CC('9h 8h 7h 6h 5h Ad Kc')))).toContain('同花顺');
    expect(describeHand(evaluate(CC('8s 8h 8d Ks Kh 2c 3d')))).toContain('葫芦');
    expect(describeHand(evaluate(CC('Qs Qh 9d 9c As 2h 3d')))).toContain('两对');
    expect(describeHand(evaluate(CC('Qs Qh 9d 7c 5s 2h 3d')))).toContain('一对');
    expect(describeHand(evaluate(CC('Ad 2h 3s 4c 5d Kh Qs')))).toContain('顺子');
  });

  it('皇家同花顺的 category 仍是同花顺', () => {
    const royal = evaluate(CC('As Ks Qs Js Ts 2h 3d'));
    expect(royal.category).toBe(HAND_CATEGORY.STRAIGHT_FLUSH);
    expect(royal.categoryName).toBe('皇家同花顺');
  });

  it('A-2-3-4-5 同花顺（钢轮）', () => {
    const hand = evaluate(CC('Ah 2h 3h 4h 5h Ks Qd'));
    expect(hand.category).toBe(HAND_CATEGORY.STRAIGHT_FLUSH);
    expect(hand.kickers).toEqual([5]);
  });

  it('7 张同花顺取最大连续 5 张', () => {
    const hand = evaluate(CC('7h 6h 5h 4h 3h 2h Ah'));
    expect(hand.category).toBe(HAND_CATEGORY.STRAIGHT_FLUSH);
    expect(hand.kickers).toEqual([7]);
  });
});
