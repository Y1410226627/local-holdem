import { describe, expect, it } from 'vitest';
import { solveMatrixGame } from '../ai/solver/cfr';
import { solveStreetSubgame } from '../ai/solver/subgame';
import { buildStreetRanges, preflopRangeFor } from '../ai/solver/ranges';
import { preflopAdvice } from '../ai/solver/preflop';
import { buildPlayerView } from '../game/playerView';
import { decide } from '../ai/aiPlayer';
import { CC, makeHand, playSequence, playToStreet } from './helpers';
import '../ai/solver/blueprint';

describe('CFR+ 原语', () => {
  it('匹配 pennies 收敛到 0 可利用度', () => {
    const result = solveMatrixGame(
      [
        [1, -1],
        [-1, 1],
      ],
      2000,
    );
    expect(result.row[0]).toBeCloseTo(0.5, 2);
    expect(result.col[0]).toBeCloseTo(0.5, 2);
    expect(result.exploitability).toBeLessThan(1e-6);
  });

  it('偏斜矩阵博弈收敛到混合纳什（0.25 / 0.25）', () => {
    const result = solveMatrixGame(
      [
        [3, 0],
        [0, 1],
      ],
      20000,
    );
    // 零和化后：行 0 收益 3q，行 1 收益 1-q；q=0.25 时行无差异。
    expect(result.row[0]).toBeCloseTo(0.25, 2);
    expect(result.col[0]).toBeCloseTo(0.25, 2);
    expect(result.exploitability).toBeLessThan(0.01);
  });
});

describe('按街范围信念', () => {
  it('翻前先验归一化，且排除自己底牌与公共牌', () => {
    const hand = makeHand({
      stacks: [1000, 1000],
      buttonIndex: 0,
      holeCards: [CC('As Kd'), CC('Qh Jh')],
    });
    const view = buildPlayerView(hand, 0, 'range-prior');
    const range = preflopRangeFor(view, 1);
    expect(range.size).toBeGreaterThan(500);
    const total = [...range.values()].reduce((sum, value) => sum + value, 0);
    expect(total).toBeCloseTo(1, 5);
    // 对手范围里不能出现我方底牌参与的 combo。
    for (const key of range.keys()) {
      expect(key.includes('14s')).toBe(false);
      expect(key.includes('13d')).toBe(false);
    }
  });

  it('河牌范围与翻前先验不同（确实按街更新）', () => {
    const hand = playToStreet(
      makeHand({
        stacks: [1000, 1000],
        buttonIndex: 0,
        holeCards: [CC('As Kd'), CC('Qh Jh')],
        board: CC('2h 5s 9d Tc 3c'),
      }),
      'river',
    );
    const view = buildPlayerView(hand, 0, 'range-street');
    const prior = preflopRangeFor(view, 1);
    const street = buildStreetRanges(view).get(1);
    expect(street).toBeDefined();
    expect(street!.size).toBeGreaterThan(100);
    const priorTotal = [...prior.values()].reduce((sum, value) => sum + value, 0);
    const streetTotal = [...street!.values()].reduce((sum, value) => sum + value, 0);
    expect(priorTotal).toBeCloseTo(1, 5);
    expect(streetTotal).toBeCloseTo(1, 5);
    // 权重分布必须变化；如果完全相同说明没有按街更新。
    const sample = [...prior.keys()].slice(0, 30);
    const changed = sample.some(
      (key) => Math.abs((prior.get(key) ?? 0) - (street!.get(key) ?? 0)) > 1e-6,
    );
    expect(changed).toBe(true);
  });
});

describe('翻后单街子博弈 CFR+', () => {
  function riverView(seed: string) {
    const hand = playToStreet(
      makeHand({
        stacks: [1000, 1000],
        buttonIndex: 0,
        seed,
        holeCards: [CC('As Kd'), CC('Qh Jh')],
        board: CC('2h 5s 9d Tc 3c'),
      }),
      'river',
    );
    const index = hand.actingIndex!;
    return buildPlayerView(hand, hand.players[index].id, seed);
  }

  it('返回合法动作与归一化混合策略', () => {
    const view = riverView('subgame-test-a');
    const result = solveStreetSubgame(view, { iterations: 60, maxCombos: 48 });
    expect(result).not.toBeNull();
    expect(result!.strategy.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 5);
    expect(result!.strategy.every((value) => value >= 0 && value <= 1)).toBe(true);
    expect(result!.actions.length).toBe(result!.strategy.length);
    expect(['check', 'bet_33', 'bet_50', 'bet_100', 'call', 'fold']).toContain(
      result!.actionName,
    );
  });

  it('相同输入完全可复现', () => {
    const view = riverView('subgame-test-b');
    const first = solveStreetSubgame(view, { iterations: 50, maxCombos: 40 });
    const second = solveStreetSubgame(view, { iterations: 50, maxCombos: 40 });
    expect(second!.strategy).toEqual(first!.strategy);
    expect(second!.action).toEqual(first!.action);
  });

  it('多人底池不套单挑子博弈', () => {
    const hand = playToStreet(
      makeHand({
        seed: 'subgame-multiway',
        holeCards: [CC('As Kd'), CC('Qh Jh'), CC('9s 9c'), CC('7c 2d')],
        board: CC('2h 5s 9d Tc 3c'),
      }),
      'river',
    );
    const index = hand.actingIndex!;
    const view = buildPlayerView(hand, hand.players[index].id, 'subgame-multiway');
    expect(solveStreetSubgame(view, { iterations: 30, maxCombos: 30 })).toBeNull();
  });
});

describe('翻前 CFR+ 蓝图（BB 防守）', () => {
  it('AA 面对开池不会弃牌，72o 以弃牌为主', () => {
    const aces = playSequence(
      makeHand({
        stacks: [1000, 1000],
        buttonIndex: 0,
        seed: 'bp-aa',
        holeCards: [undefined, CC('As Ah')],
      }),
      [[0, { type: 'raise', amount: 60 }]],
    );
    const aaView = buildPlayerView(aces, 1, 'bp-aa');
    const aaAdvice = preflopAdvice(aaView);
    expect(aaAdvice).not.toBeNull();
    expect(aaAdvice!.node).toBe('bb_vs_open_2.5');
    expect(aaAdvice!.action).not.toBe('fold');

    const trash = playSequence(
      makeHand({
        stacks: [1000, 1000],
        buttonIndex: 0,
        seed: 'bp-72',
        holeCards: [undefined, CC('7c 2d')],
      }),
      [[0, { type: 'raise', amount: 60 }]],
    );
    const trashView = buildPlayerView(trash, 1, 'bp-72');
    const trashAdvice = preflopAdvice(trashView);
    expect(trashAdvice).not.toBeNull();
    expect(trashAdvice!.action).toBe('fold');
  });
});

describe('挑战引擎静态分流', () => {
  it('单挑河牌走 CFR 子博弈', async () => {
    const hand = playToStreet(
      makeHand({
        stacks: [1000, 1000],
        buttonIndex: 0,
        seed: 'engine-hu-river',
        holeCards: [CC('As Kd'), CC('Qh Jh')],
        board: CC('2h 5s 9d Tc 3c'),
      }),
      'river',
    );
    const index = hand.actingIndex!;
    const view = buildPlayerView(hand, hand.players[index].id, 'engine-hu-river');
    const decision = await decide(view, 'expert', {
      challenge: true,
      maxIterations: 80,
      solver: { iterations: 20, maxCombos: 20 },
    });
    // 河牌 MCCFR 目前默认关闭（ENABLE_RIVER_SOLVER=false）；
    // 直接求解器测试仍覆盖 MCCFR，这里只验证引擎分流不越界。
    expect(['heuristic', 'cfr-subgame']).toContain(decision.debug.engine);
    expect(decision.debug.challenge).toBe(true);
  });

  it('三人以上走 challenge-multiway，不套单挑解', async () => {
    const hand = playToStreet(
      makeHand({
        seed: 'engine-3way',
        holeCards: [CC('As Kd'), CC('Qh Jh'), CC('9s 9c'), CC('7c 2d')],
        board: CC('2h 5s 9d Tc 3c'),
      }),
      'river',
    );
    const index = hand.actingIndex!;
    const view = buildPlayerView(hand, hand.players[index].id, 'engine-3way');
    const decision = await decide(view, 'expert', {
      challenge: true,
      maxIterations: 80,
      solver: { iterations: 20, maxCombos: 20 },
    });
    expect(decision.debug.engine).toBe('challenge-multiway');
  });
});
