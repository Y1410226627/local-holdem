import { describe, expect, it } from 'vitest';
import { awardPots, buildSidePots, calcUncalledRefund } from '../game/pot';
import type { PotContribution } from '../game/pot';

function contrib(entries: [number, number, boolean?][]): PotContribution[] {
  return entries.map(([playerId, totalCommitted, folded]) => ({
    playerId,
    name: `P${playerId}`,
    totalCommitted,
    folded: folded ?? false,
  }));
}

describe('边池构建', () => {
  it('所有玩家投入相同：只有一个主池', () => {
    const pots = buildSidePots(contrib([[1, 100], [2, 100], [3, 100]]));
    expect(pots).toHaveLength(1);
    expect(pots[0].label).toBe('主池');
    expect(pots[0].amount).toBe(300);
    expect(pots[0].eligiblePlayerIds.sort()).toEqual([1, 2, 3]);
  });

  it('主池 + 一层边池', () => {
    const pots = buildSidePots(contrib([[1, 100], [2, 300], [3, 300]]));
    expect(pots).toHaveLength(2);
    expect(pots[0].label).toBe('主池');
    expect(pots[0].amount).toBe(300);
    expect(pots[0].eligiblePlayerIds.sort()).toEqual([1, 2, 3]);
    expect(pots[1].label).toBe('边池 1');
    expect(pots[1].amount).toBe(400);
    expect(pots[1].eligiblePlayerIds.sort()).toEqual([2, 3]);
  });

  it('多层边池：50 / 100 / 200 / 200', () => {
    const pots = buildSidePots(contrib([[1, 50], [2, 100], [3, 200], [4, 200]]));
    expect(pots.map((pot) => pot.amount)).toEqual([200, 150, 200]);
    expect(pots.map((pot) => pot.label)).toEqual(['主池', '边池 1', '边池 2']);
    expect(pots[0].eligiblePlayerIds.sort()).toEqual([1, 2, 3, 4]);
    expect(pots[1].eligiblePlayerIds.sort()).toEqual([2, 3, 4]);
    expect(pots[2].eligiblePlayerIds.sort()).toEqual([3, 4]);
    const total = pots.reduce((sum, pot) => sum + pot.amount, 0);
    expect(total).toBe(550);
  });

  it('弃牌玩家的筹码留在底池，但无资格赢取', () => {
    const pots = buildSidePots(contrib([[1, 100], [2, 100], [3, 100, true]]));
    expect(pots[0].amount).toBe(300);
    expect(pots[0].eligiblePlayerIds.sort()).toEqual([1, 2]);
  });

  it('未被跟注的多余下注不计入底池层级（由退回逻辑处理）', () => {
    const refund = calcUncalledRefund(contrib([[1, 500], [2, 300]]));
    expect(refund).toEqual({ playerId: 1, name: 'P1', amount: 200 });
    const afterRefund = buildSidePots(contrib([[1, 300], [2, 300]]));
    expect(afterRefund.reduce((sum, pot) => sum + pot.amount, 0)).toBe(600);
  });
});

describe('未被跟注下注退回', () => {
  it('最高投入者唯一时退回差额', () => {
    expect(calcUncalledRefund(contrib([[1, 300], [2, 200], [3, 100]]))).toEqual({
      playerId: 1,
      name: 'P1',
      amount: 100,
    });
  });

  it('最高投入并列时不退回', () => {
    expect(calcUncalledRefund(contrib([[1, 300], [2, 300], [3, 100]]))).toBeNull();
  });

  it('所有投入相等时不退回', () => {
    expect(calcUncalledRefund(contrib([[1, 100], [2, 100]]))).toBeNull();
  });

  it('只有一人投入时全部退回', () => {
    expect(calcUncalledRefund(contrib([[1, 100]]))).toEqual({
      playerId: 1,
      name: 'P1',
      amount: 100,
    });
  });

  it('无投入时返回 null', () => {
    expect(calcUncalledRefund([])).toBeNull();
  });
});

describe('底池分配', () => {
  function contenders(entries: [number, number][]): Map<number, { playerId: number; name: string; score: number }> {
    return new Map(
      entries.map(([playerId, score]) => [playerId, { playerId, name: `P${playerId}`, score }]),
    );
  }

  it('单一赢家拿走全部底池', () => {
    const pots = buildSidePots(contrib([[1, 100], [2, 100], [3, 100]]));
    const awards = awardPots(pots, contenders([[1, 10], [2, 20], [3, 5]]), [1, 2, 3]);
    expect(awards).toHaveLength(1);
    expect(awards[0].winnerIds).toEqual([2]);
    expect(awards[0].payouts).toEqual([{ playerId: 2, name: 'P2', amount: 300 }]);
  });

  it('并列平分底池', () => {
    const pots = buildSidePots(contrib([[1, 100], [2, 100]]));
    const awards = awardPots(pots, contenders([[1, 50], [2, 50]]), [1, 2]);
    expect(awards[0].winnerIds).toEqual([1, 2]);
    expect(awards[0].payouts.map((payout) => payout.amount)).toEqual([100, 100]);
  });

  it('奇数筹码给按钮左边第一个赢家', () => {
    const pots = buildSidePots(contrib([[1, 100], [2, 100]]));
    // 底池 200 无法构造奇数，这里直接对 awardPots 用 101 的底池验证。
    const customPots = [
      { index: 0, label: '主池', amount: 101, eligiblePlayerIds: [1, 2] },
    ];
    // 按钮左边顺序：2 先于 1
    const awards = awardPots(customPots, contenders([[1, 50], [2, 50]]), [2, 1]);
    expect(awards[0].payouts).toEqual([
      { playerId: 2, name: 'P2', amount: 51 },
      { playerId: 1, name: 'P1', amount: 50 },
    ]);
    expect(awards[0].oddChips).toBe(1);
    expect(awards[0].oddChipTo).toBe(2);
    void pots;
  });

  it('主池与边池由不同玩家赢得', () => {
    const pots = buildSidePots(contrib([[1, 100], [2, 300], [3, 300]]));
    const awards = awardPots(pots, contenders([[1, 999], [2, 500], [3, 400]]), [1, 2, 3]);
    expect(awards).toHaveLength(2);
    expect(awards[0].payouts).toEqual([{ playerId: 1, name: 'P1', amount: 300 }]);
    expect(awards[1].payouts).toEqual([{ playerId: 2, name: 'P2', amount: 400 }]);
  });

  it('玩家不能赢取自己未达到层级的边池', () => {
    const pots = buildSidePots(contrib([[1, 50], [2, 200], [3, 200]]));
    // P1 牌最大，但只能赢主池 150；边池在 P2/P3 之间比较。
    const awards = awardPots(pots, contenders([[1, 999], [2, 500], [3, 600]]), [1, 2, 3]);
    expect(awards[0].payouts[0]).toEqual({ playerId: 1, name: 'P1', amount: 150 });
    expect(awards[1].payouts[0]).toEqual({ playerId: 3, name: 'P3', amount: 300 });
  });

  it('弃牌玩家不会出现在赢家列表', () => {
    const pots = buildSidePots(contrib([[1, 100], [2, 100], [3, 100, true]]));
    const awards = awardPots(pots, contenders([[1, 10], [2, 20], [3, 30]]), [1, 2, 3]);
    expect(awards[0].winnerIds).not.toContain(3);
    expect(awards[0].payouts[0].playerId).toBe(2);
  });

  it('所有底池派发总额等于底池总额', () => {
    const pots = buildSidePots(contrib([[1, 25], [2, 80], [3, 300], [4, 300]]));
    const awards = awardPots(
      pots,
      contenders([[1, 10], [2, 20], [3, 30], [4, 40]]),
      [1, 2, 3, 4],
    );
    const awarded = awards.reduce(
      (sum, award) => sum + award.payouts.reduce((inner, payout) => inner + payout.amount, 0),
      0,
    );
    const potTotal = pots.reduce((sum, pot) => sum + pot.amount, 0);
    expect(awarded).toBe(potTotal);
  });
});
