import { describe, expect, it } from 'vitest';
import type { Card, Rank, Suit } from '../game/types';
import { parseCard } from '../game/cards';
import { rangeAdvantage, type WeightedCombo } from '../ai/rangeAdvantage';

const c = (rank: Rank, suit: Suit): Card => ({ rank, suit });

/** "Ah" / "Kd" 之类的简写。 */
const card = (text: string): Card => parseCard(text);

const combo = (first: string, second: string, weight = 1): WeightedCombo => ({
  first: card(first),
  second: card(second),
  weight,
});

const board = (...texts: string[]): Card[] => texts.map(card);

/** A 高、干燥、不连：A/K/9 彩虹。 */
const A_HIGH_DRY = board('Ah', 'Kd', '9c');

const NUTS = [combo('As', 'Ac'), combo('Ks', 'Kc'), combo('Ad', 'Kc')];
const AIR = [combo('7d', '2s'), combo('8h', '3c'), combo('4d', '2c')];

describe('rangeAdvantage：范围优势', () => {
  it('范围数据缺失 → 中性，不抛错', () => {
    const r = rangeAdvantage({ board: A_HIGH_DRY, heroRange: null, villainRange: undefined });
    expect(r.edge).toBe(0);
    expect(r.nutShare).toBe(0);
    expect(r.villainHitShare).toBe(0);
  });

  it('公共牌不足 3 张 → 中性，不抛错', () => {
    const r = rangeAdvantage({
      board: board('Ah', 'Kd'),
      heroRange: NUTS,
      villainRange: AIR,
    });
    expect(r.edge).toBe(0);
  });

  it('我方全是坚果、对手全是空气 → edge 明显为正', () => {
    const r = rangeAdvantage({ board: A_HIGH_DRY, heroRange: NUTS, villainRange: AIR });
    expect(r.edge).toBeGreaterThan(0.3);
    // AA / KK 在 A-K-9 上都是三条，AK 是两对 → 坚果占比 2/3。
    expect(r.nutShare).toBeCloseTo(2 / 3, 5);
    expect(r.villainHitShare).toBeLessThan(0.01);
  });

  it('反例：对手全坚果、我方全空气 → edge 明显为负', () => {
    const r = rangeAdvantage({ board: A_HIGH_DRY, heroRange: AIR, villainRange: NUTS });
    expect(r.edge).toBeLessThan(-0.3);
    expect(r.nutShare).toBe(0);
    expect(r.villainHitShare).toBeCloseTo(1, 5);
  });

  it('双方范围完全相同 → edge ≈ 0', () => {
    const r = rangeAdvantage({ board: A_HIGH_DRY, heroRange: NUTS, villainRange: NUTS });
    expect(Math.abs(r.edge)).toBeLessThan(0.02);
  });

  it('对称性：交换双方输入 → edge 符号相反、绝对值相等', () => {
    const forward = rangeAdvantage({ board: A_HIGH_DRY, heroRange: NUTS, villainRange: AIR });
    const backward = rangeAdvantage({ board: A_HIGH_DRY, heroRange: AIR, villainRange: NUTS });
    expect(forward.edge).toBeGreaterThan(0);
    expect(Math.abs(forward.edge + backward.edge)).toBeLessThan(1e-9);
  });

  it('空范围数组不崩', () => {
    const r = rangeAdvantage({ board: A_HIGH_DRY, heroRange: [], villainRange: [] });
    expect(r).toEqual({ edge: 0, nutShare: 0, villainHitShare: 0 });
  });

  it('单元素范围可用', () => {
    const r = rangeAdvantage({
      board: A_HIGH_DRY,
      heroRange: [combo('As', 'Ac')],
      villainRange: [combo('7d', '2s')],
    });
    expect(r.edge).toBeGreaterThan(0);
    expect(r.nutShare).toBe(1);
    expect(r.villainHitShare).toBe(0);
  });

  it('只有一侧范围时仍能给出一侧的占比，但 edge 保持中性', () => {
    const r = rangeAdvantage({ board: A_HIGH_DRY, heroRange: NUTS, villainRange: null });
    expect(r.edge).toBe(0);
    expect(r.nutShare).toBeCloseTo(2 / 3, 5);
    expect(r.villainHitShare).toBe(0);
  });

  it('nutShare / villainHitShare 值域都在 [0, 1]', () => {
    const boards = [A_HIGH_DRY, board('9s', '8s', '7d'), board('Ac', 'Ad', '3h')];
    for (const current of boards) {
      const r = rangeAdvantage({ board: current, heroRange: NUTS, villainRange: AIR });
      expect(r.nutShare).toBeGreaterThanOrEqual(0);
      expect(r.nutShare).toBeLessThanOrEqual(1);
      expect(r.villainHitShare).toBeGreaterThanOrEqual(0);
      expect(r.villainHitShare).toBeLessThanOrEqual(1);
      expect(r.edge).toBeGreaterThanOrEqual(-1);
      expect(r.edge).toBeLessThanOrEqual(1);
    }
  });

  it('确定性：同一输入连续两次结果完全相等', () => {
    const first = rangeAdvantage({ board: A_HIGH_DRY, heroRange: NUTS, villainRange: AIR });
    const second = rangeAdvantage({ board: A_HIGH_DRY, heroRange: NUTS, villainRange: AIR });
    expect(second).toEqual(first);
  });

  it('函数形式与数组形式给出同一结果', () => {
    const weightOf = new Map<string, number>();
    for (const entry of NUTS) {
      weightOf.set(`${entry.first.rank}${entry.first.suit}|${entry.second.rank}${entry.second.suit}`, entry.weight);
    }
    const heroFn = (first: Card, second: Card) =>
      (weightOf.get(`${first.rank}${first.suit}|${second.rank}${second.suit}`) ??
        weightOf.get(`${second.rank}${second.suit}|${first.rank}${first.suit}`) ??
        0);
    const fromArray = rangeAdvantage({ board: A_HIGH_DRY, heroRange: NUTS, villainRange: AIR });
    const fromFn = rangeAdvantage({ board: A_HIGH_DRY, heroRange: heroFn, villainRange: AIR });
    expect(fromFn.edge).toBeCloseTo(fromArray.edge, 12);
    expect(fromFn.nutShare).toBeCloseTo(fromArray.nutShare, 12);
  });

  it('deadCards 会排除冲突组合（函数形式）', () => {
    // 只给我方发 As 相关的组合；把 As 当作死牌后整个范围应消失 → 中性。
    const heroFn = (first: Card, second: Card) =>
      first.rank === 14 && first.suit === 's' ? 1 : second.rank === 14 && second.suit === 's' ? 1 : 0;
    const alive = rangeAdvantage({ board: A_HIGH_DRY, heroRange: heroFn, villainRange: AIR });
    expect(alive.edge).not.toBe(0);
    const blocked = rangeAdvantage({
      board: A_HIGH_DRY,
      heroRange: heroFn,
      villainRange: AIR,
      deadCards: [c(14, 's')],
    });
    expect(blocked.edge).toBe(0);
  });

  it('性能：10,000 次调用总耗时 < 10 秒（防 O(n²) 回归）', () => {
    // 全范围（1176 组合 / 侧）是函数形式的最坏情况：任何复杂度回退都会在这里超时。
    const fullRange = (first: Card, second: Card) => ((first.rank + second.rank) % 17) / 17 + 0.01;
    rangeAdvantage({ board: A_HIGH_DRY, heroRange: fullRange, villainRange: fullRange }); // 预热
    const started = performance.now();
    for (let index = 0; index < 10_000; index++) {
      rangeAdvantage({ board: A_HIGH_DRY, heroRange: fullRange, villainRange: fullRange });
    }
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(10_000);
  });
});
