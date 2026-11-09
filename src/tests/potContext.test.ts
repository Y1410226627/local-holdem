import { describe, expect, it } from 'vitest';
import { readPotContext, threeBetCbetBonus } from '../ai/potContext';
import type { PlayerView } from '../game/playerView';
import type { ActionRecord, Card, PlayerAction } from '../game/types';

/** 只造 readPotContext 需要的字段，其余用最小占位。 */
function viewWith(me: number, preflop: Array<{ actorId: number; action: PlayerAction }>): PlayerView {
  const actions = preflop.map((a, i) => ({
    handNo: 1,
    street: 'preflop' as const,
    actorId: a.actorId,
    actorName: `p${a.actorId}`,
    action: a.action,
    paid: 0,
    toAmount: 0,
    potAfter: 0,
    stackAfter: 0,
    board: [] as Card[],
    _i: i,
  })) as unknown as ActionRecord[];
  return { viewerId: me, actions } as unknown as PlayerView;
}

describe('readPotContext：底池类型识别', () => {
  it('无人加注 = 跛入池', () => {
    const ctx = readPotContext(viewWith(0, [
      { actorId: 0, action: { type: 'call' } },
      { actorId: 1, action: { type: 'check' } },
    ]));
    expect(ctx.type).toBe('limped');
    expect(ctx.isAggressor).toBe(false);
  });

  it('一次加注 = 单加注池，加注者是进攻方', () => {
    const ctx = readPotContext(viewWith(0, [
      { actorId: 0, action: { type: 'raise', amount: 60 } },
      { actorId: 1, action: { type: 'call' } },
    ]));
    expect(ctx.type).toBe('srp');
    expect(ctx.isAggressor).toBe(true);
  });

  it('两次加注 = 3-bet 池；最后加注者才是进攻方', () => {
    const asCaller = readPotContext(viewWith(0, [
      { actorId: 0, action: { type: 'raise', amount: 60 } },
      { actorId: 1, action: { type: 'raise', amount: 180 } },
      { actorId: 0, action: { type: 'call' } },
    ]));
    expect(asCaller.type).toBe('3bet');
    expect(asCaller.isAggressor).toBe(false);

    const asBettor = readPotContext(viewWith(1, [
      { actorId: 0, action: { type: 'raise', amount: 60 } },
      { actorId: 1, action: { type: 'raise', amount: 180 } },
      { actorId: 0, action: { type: 'call' } },
    ]));
    expect(asBettor.type).toBe('3bet');
    expect(asBettor.isAggressor).toBe(true);
  });

  it('三次以上 = 4-bet+', () => {
    const ctx = readPotContext(viewWith(0, [
      { actorId: 0, action: { type: 'raise', amount: 60 } },
      { actorId: 1, action: { type: 'raise', amount: 180 } },
      { actorId: 0, action: { type: 'raise', amount: 520 } },
    ]));
    expect(ctx.type).toBe('4bet+');
    expect(ctx.isAggressor).toBe(true);
  });

  it('只有作为进攻方且在 3-bet 池才给持续下注加成', () => {
    expect(threeBetCbetBonus({ type: '3bet', isAggressor: true, raises: 2 })).toBeGreaterThan(0.3);
    expect(threeBetCbetBonus({ type: '3bet', isAggressor: false, raises: 2 })).toBe(0);
    expect(threeBetCbetBonus({ type: 'srp', isAggressor: true, raises: 1 })).toBe(0);
  });
});
